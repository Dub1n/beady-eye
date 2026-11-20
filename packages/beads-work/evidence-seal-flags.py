import array
import fcntl
import json
import os
import stat
import sys

FS_IOC_GETFLAGS = 0x80086601
FS_IMMUTABLE_FL = 0x00000010
CAP_DAC_OVERRIDE = 1
CAP_DAC_READ_SEARCH = 2
CAP_FOWNER = 3
CAP_CHOWN = 0
CAP_LINUX_IMMUTABLE = 9
CAP_SYS_ADMIN = 21
MAX_PATHS = 2048
MAX_INPUT = 1024 * 1024
MAX_PATH_BYTES = 4095
MAX_COMPONENT_BYTES = 255


def reject():
    raise SystemExit(1)


def capabilities():
    with open("/proc/self/status", "r", encoding="ascii") as status:
        fields = {line.split(":", 1)[0]: line.split(":", 1)[1].strip()
                  for line in status if ":" in line}
    effective = int(fields.get("CapEff", "0"), 16)
    permitted = int(fields.get("CapPrm", "0"), 16)
    forbidden = ((1 << CAP_CHOWN) | (1 << CAP_DAC_OVERRIDE) |
                 (1 << CAP_DAC_READ_SEARCH) | (1 << CAP_FOWNER) |
                 (1 << CAP_LINUX_IMMUTABLE) | (1 << CAP_SYS_ADMIN))
    if (effective | permitted) & forbidden:
        reject()


def snapshot(fd, path):
    info = os.fstat(fd)
    if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
        reject()
    flags = array.array("l", [0])
    fcntl.ioctl(fd, FS_IOC_GETFLAGS, flags, True)
    mount_id = None
    with open(f"/proc/self/fdinfo/{fd}", "r", encoding="ascii") as fdinfo:
        for line in fdinfo:
            if line.startswith("mnt_id:"):
                mount_id = int(line.split(":", 1)[1].strip())
                break
    if mount_id is None:
        reject()
    return {
        "path": path,
        "uid": info.st_uid,
        "mode": stat.S_IMODE(info.st_mode),
        "flags": int(flags[0]),
        "dev": info.st_dev,
        "ino": info.st_ino,
        "size": info.st_size,
        "mountId": mount_id,
        "directory": stat.S_ISDIR(info.st_mode),
        "regular": stat.S_ISREG(info.st_mode),
    }


def facts_for(path):
    if (not os.path.isabs(path) or os.path.normpath(path) != path or
            len(os.fsencode(path)) > MAX_PATH_BYTES):
        reject()
    components = [part for part in path.split("/") if part]
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        info = os.fstat(fd)
        current_path = "/"
        result = [snapshot(fd, current_path)]
        for index, component in enumerate(components):
            directory_fd = fd
            path_fd = os.open(
                component,
                os.O_PATH | os.O_NOFOLLOW | os.O_CLOEXEC |
                (os.O_DIRECTORY if index < len(components) - 1 else 0),
                dir_fd=directory_fd,
            )
            path_info = os.fstat(path_fd)
            if not (stat.S_ISDIR(path_info.st_mode) or stat.S_ISREG(path_info.st_mode)):
                os.close(path_fd)
                reject()
            if index < len(components) - 1 and not stat.S_ISDIR(path_info.st_mode):
                os.close(path_fd)
                reject()
            next_fd = os.open(
                component,
                os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW | os.O_CLOEXEC |
                (os.O_DIRECTORY if index < len(components) - 1 else 0),
                dir_fd=directory_fd,
            )
            read_info = os.fstat(next_fd)
            os.close(path_fd)
            if read_info.st_dev != path_info.st_dev or read_info.st_ino != path_info.st_ino:
                os.close(next_fd)
                reject()
            os.close(directory_fd)
            fd = next_fd
            current_path = os.path.join(current_path, component)
            result.append(snapshot(fd, current_path))
        return result
    finally:
        os.close(fd)


def mount_type(mount_id):
    with open("/proc/self/mountinfo", "r", encoding="ascii") as mountinfo:
        for line in mountinfo:
            fields = line.split()
            separator = fields.index("-")
            if int(fields[0]) == mount_id:
                return fields[separator + 1]
    return None


def main():
    if os.geteuid() == 0:
        reject()
    capabilities()
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        reject()
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict) or set(request) != {"projectRoot", "paths"}:
        reject()
    project = request["projectRoot"]
    requested = request["paths"]
    if (not isinstance(project, str) or not project.startswith("/") or
            os.path.normpath(project) != project or len(os.fsencode(project)) > MAX_PATH_BYTES or
            not isinstance(requested, list) or
            not requested or len(requested) > MAX_PATHS):
        reject()
    for path in requested:
        if (not isinstance(path, str) or not path.startswith("/") or
                os.path.normpath(path) != path or len(os.fsencode(path)) > MAX_PATH_BYTES or
                any(len(os.fsencode(component)) > MAX_COMPONENT_BYTES
                    for component in path.split("/") if component)):
            reject()
    if project not in requested or "/" not in requested:
        reject()
    result = []
    for path in requested:
        result.extend(facts_for(path))
    by_path = {}
    for fact in result:
        previous = by_path.get(fact["path"])
        if previous is not None and any(
                previous[key] != fact[key]
                for key in ("uid", "mode", "flags", "dev", "ino", "size", "mountId")):
            reject()
        by_path[fact["path"]] = fact
    project_fact = by_path.get(project)
    if project_fact is None or mount_type(project_fact["mountId"]) != "ext4":
        reject()
    for fact in result:
        if fact["path"] == project:
            fact["filesystem"] = mount_type(fact["mountId"])
    if by_path["/"]["uid"] != 0 or by_path["/"]["mode"] & 0o022:
        reject()
    for fact in result:
        current = fact["path"]
        while current != "/":
            parent = by_path.get(os.path.dirname(current))
            if parent is None:
                reject()
            protected = ((fact["flags"] & FS_IMMUTABLE_FL) != 0 or
                         (parent["flags"] & FS_IMMUTABLE_FL) != 0 or
                         (parent["uid"] == 0 and (parent["mode"] & 0o022) == 0))
            if not protected or fact["mountId"] != parent["mountId"] or fact["dev"] != parent["dev"]:
                reject()
            current = parent["path"]
    print(json.dumps([by_path[path] for path in requested], separators=(",", ":")))


if __name__ == "__main__":
    main()
