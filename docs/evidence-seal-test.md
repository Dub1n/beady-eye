# Operator step for the immutable evidence test

This is a **dummy-only** administrator setup, not a deployment or instructions
for sealing a live checkout. The fixture and writer must run as a normal user.
Do not install a `sudoers` rule, grant `chattr` file capabilities, elevate a
Windows helper, or put a password in a tool request.

From a WSL terminal, inspect and run this literal block. It creates a fresh,
uniquely named directory under `/var/lib`; it does not run any checkout code
as root. Save the printed path even if a later command fails.

```sh
sudo /bin/sh -eu -c '
  umask 022
  d=$(/usr/bin/mktemp -d /var/lib/beady-eye-seal-test.XXXXXXXX)
  printf "Dummy test root: %s\n" "$d"
  /usr/bin/chmod 0755 "$d"
  /usr/bin/mkdir -m 0755 "$d/project" "$d/project/evidence"
  printf "Invented sealed evidence only.\n" > "$d/project/evidence/receipt.txt"
  h=$(/usr/bin/sha256sum "$d/project/evidence/receipt.txt")
  printf "{\"version\":1,\"project\":\"%s/project\",\"files\":{\"evidence/receipt.txt\":\"%s\"}}\n" \
    "$d" "${h%% *}" > "$d/manifest.json"
  /usr/bin/chattr +i "$d/project/evidence/receipt.txt" "$d/manifest.json"
  /usr/bin/lsattr -d "$d/project/evidence/receipt.txt" "$d/manifest.json"
'
```

The evidence and manifest should both display `i`. Their directory hierarchy
is root-owned and not writable by the fixture. A successful setup is **not**
a passing guard test: the ordinary writer must read and verify the seal, and
ordinary Linux and Windows processes must be denied mutations. Record the
actual denied operations and confirm the original hashes independently.
This does not defend against an actor deliberately obtaining administrative
authority or a Windows helper already running as an administrator.

The positive setup above combines two protections: root-owned `0755`
directories protect the entry names and `+i` seals the regular files.
Because those files are also root-owned `0644`, a write denial on its own
does not distinguish ordinary mode permissions from the immutable flag.
Require independent flag readback on both files as well as the denial
controls. A passing result applies to the tested paths and ordinary
identities, not to every file in a checkout or every Windows execution mode.

From the fork checkout, run the Linux probe with a *new* output directory.
For a Windows check, use an ordinary, non-elevated PowerShell session and
the UNC path for that same dummy root; do not weaken machine execution
policy to run it. Examples (replace the placeholders):

```sh
node tools/test-evidence-seal.mjs /var/lib/beady-eye-seal-test.<suffix> /tmp/<new-private-output>
```

```powershell
& '<trusted copy of test-evidence-seal.ps1>' -Root '\\wsl.localhost\<distro>\var\lib\beady-eye-seal-test.<suffix>'
```

Verify read and writable scratch controls and inspect both platform
receipts and final bytes. A provider error such as “unsupported” or
“invalid path” does not show that the seal denied the operation. Likewise,
PowerShell returning success while the file still exists proves neither
deletion nor an explicit access denial. Do not qualify Windows cleanup
on those results alone.

The writer must never clear these flags. To remove this disposable trial
after review, the operator can use `sudo chattr -i` on the **two exact files**
under its printed root, then remove those two files and their empty test
directories. Do not clear flags recursively or act on a real receipt path.

### Checking from a different, writable project

The same dummy seal can qualify the external-archive code path without
creating a tracker in `/var/lib`. From the source checkout, supply the
existing administrator-created directory to the opt-in writer regression:

```sh
BDI_TEST_ADMIN_SEAL_ROOT=/var/lib/beady-eye-seal-test.<suffix> \
  node --test --test-name-pattern='a writable checkout checks' \
  adapters/omo-work/test/trusted-fixture.test.mjs
```

The regression uses a disposable checkout and a synthetic tracker, not
the live Beads store. An invented accepted receipt is represented in the
tracker and at its normal writable checkout path. With `archiveRoot` set
to the sealed copy's directory, the writer must reject a tracker and
checkout that agree with each other but disagree with the archive. The
matching case should finish and write its new receipt in the disposable
checkout. Neither case changes the sealed archive. If native Windows
PowerShell is available, the fixture also exercises a disposable Windows
command and cleanup. This is not a Windows ADB or Android device check.
