import test from 'node:test';
// allow: SIZE_OK — The pinned recorder regressions remain the assigned contract suite.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, readFile, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRunContext} from '../harness-observation.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qrclip-harness-observation-test-'));
  t.after(async () => rm(root, {recursive: true, force: true}));
  return root;
}

const nodeScript = source => [process.execPath, ['-e', source]];

function workCheckEnvironment(t, values) {
  const keys = ['QRCLIP_WORK_CHECK_NONCE', 'QRCLIP_AGENT_WORK_ID', 'QRCLIP_WORK_CHECK_ATTEMPT'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  for (const key of keys) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
}

test('work check binding survives executed terminal evidence without mutation', async t => {
  const binding = {nonce: 'fresh-fixture-check', id: 'qrclip-test', attempt: 'current-attempt'};
  workCheckEnvironment(t, {QRCLIP_WORK_CHECK_NONCE: binding.nonce,
    QRCLIP_AGENT_WORK_ID: binding.id, QRCLIP_WORK_CHECK_ATTEMPT: binding.attempt});
  const run = await createRunContext({
    output: await fixture(t), scenario: 'bound-check', budgetMs: 3000, primaryMs: 2000,
  });
  assert.deepEqual(run.workCheck, binding);
  assert.throws(() => { run.workCheck.nonce = 'borrowed-check'; }, TypeError);
  const [command, args] = nodeScript("process.stdout.write('executed')");
  await run.runCommand(command, args);
  run.setPrimary({passed: true});
  assert.equal((await run.finalize()).ok, true);
  const manifest = JSON.parse(await readFile(path.join(run.outputDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.status, 'complete');
  assert.equal(manifest.commands.length, 1);
  assert.deepEqual(manifest.workCheck, binding);
});

test('partial work check binding is rejected before creating evidence', async t => {
  workCheckEnvironment(t, {QRCLIP_WORK_CHECK_NONCE: 'partial-check'});
  await assert.rejects(createRunContext({
    output: await fixture(t), scenario: 'partial-binding',
  }), {name: 'TypeError', message: /binding requires nonce, work id and attempt/});
});

test('ordinary work attribution does not fabricate a check binding', async t => {
  workCheckEnvironment(t, {QRCLIP_AGENT_WORK_ID: 'qrclip-test'});
  const run = await createRunContext({output: await fixture(t), scenario: 'work-attribution'});
  assert.equal(run.workCheck, undefined);
  const manifest = JSON.parse(await readFile(path.join(run.outputDir, 'manifest.json'), 'utf8'));
  assert.equal(Object.hasOwn(manifest, 'workCheck'), false);
});

test('initial manifest is incomplete and child output uses a private subdirectory', async t => {
  const root = await fixture(t);
  const parentManifest = path.join(root, 'manifest.json');
  await writeFile(parentManifest, '{"parent":"keep"}\n');
  const run = await createRunContext({output: root, scenario: 'contract', budgetMs: 1000, primaryMs: 700});
  const manifest = JSON.parse(await readFile(path.join(run.outputDir, 'manifest.json'), 'utf8'));

  assert.notEqual(run.outputDir, root);
  assert.equal(manifest.status, 'incomplete');
  assert.equal(manifest.scenario, 'contract');
  assert.deepEqual(JSON.parse(await readFile(parentManifest, 'utf8')), {parent: 'keep'});
});

test('expired command deadlines reject before spawning a child', async t => {
  const run = await createRunContext({
    output: await fixture(t),
    scenario: 'expired-before-spawn',
    budgetMs: 1000,
    primaryMs: 700,
  });
  const sentinel = path.join(run.outputDir, 'child-started');
  const [command, args] = nodeScript("require('node:fs').writeFileSync(process.argv[1],'started')");
  args.push(sentinel);
  let spawned = false;

  const outcome = await run.runCommand(command, args, {
    timeout: 0,
    onSpawn: () => { spawned = true; },
  }).then(value => ({value}), error => ({error}));
  assert.equal(spawned, false);
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.record.outcome, 'deadline-expired-before-spawn');
  assert.equal(outcome.error.record.exit, undefined);
  assert.equal(outcome.error.record.close, undefined);
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});

test('expired inherited cleanup deadline prevents primary child admission', async t => {
  const previous = process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS;
  t.after(() => {
    if (previous === undefined) delete process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS;
    else process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS = previous;
  });
  process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS = '1';
  const run = await createRunContext({
    output: await fixture(t), scenario: 'expired-cleanup', budgetMs: 1000, primaryMs: 700,
  });
  const sentinel = path.join(run.outputDir, 'child-started');
  const [command, args] = nodeScript("require('node:fs').writeFileSync(process.argv[1],'started')");
  args.push(sentinel);
  let spawned = false;
  const outcome = await run.runCommand(command, args, {
    onSpawn: () => { spawned = true; },
  }).then(value => ({value}), error => ({error}));
  assert.equal(spawned, false);
  assert.equal(outcome.error?.record.outcome, 'deadline-expired-before-spawn');
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});

test('inherited cleanup cutoff reserves this run’s cleanup partition', async t => {
  const previous = process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS;
  t.after(() => {
    if (previous === undefined) delete process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS;
    else process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS = previous;
  });
  process.env.QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS = String(Date.now() + 20_000);
  const run = await createRunContext({
    output: await fixture(t), budgetMs: 60_000, primaryMs: 40_000,
    cleanupMs: 7_000, publicationMs: 5_000,
  });
  assert.equal(run.deadlines.cleanupEpochMs - run.deadlines.primaryEpochMs, 7_000);
});

test('nested observers compose simultaneous inherited deadlines without reserving primary twice', async t => {
  const run = await createRunContext({
    output: await fixture(t), scenario: 'nested-parent', budgetMs: 60_000,
    primaryMs: 40_000, cleanupMs: 10_000, publicationMs: 5_000,
  });
  const inherited = {
    ...process.env,
    QRCLIP_HARNESS_DEADLINE_EPOCH_MS: String(run.deadlines.wholeEpochMs),
    QRCLIP_HARNESS_PRIMARY_DEADLINE_EPOCH_MS: String(run.deadlines.primaryEpochMs),
    QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS: String(run.deadlines.cleanupEpochMs),
  };
  const observer = new URL('../harness-observation.mjs', import.meta.url).href;
  const source = `
    import {createRunContext} from ${JSON.stringify(observer)};
    const child = await createRunContext({output: process.argv[1], budgetMs: 60000,
      primaryMs: 40000, cleanupMs: 7000, publicationMs: 5000});
    const command = await child.runCommand(process.execPath, ['-e', 'process.stdout.write("ok")']);
    child.setPrimary({passed: true});
    const terminal = await child.finalize({cleanupVerified: true});
    console.log(JSON.stringify({deadlines: child.deadlines, stdout: command.stdout, ok: terminal.ok}));
  `;
  const result = await run.runCommand(process.execPath, ['--input-type=module', '-e', source, run.outputDir], {
    phase: 'whole', timeout: 20_000, env: inherited,
  });
  const child = JSON.parse(result.stdout);
  assert.equal(child.ok, true);
  assert.equal(child.stdout, 'ok');
  assert.ok(child.deadlines.wholeEpochMs <= run.deadlines.wholeEpochMs + 2);
  assert.ok(child.deadlines.cleanupEpochMs <= run.deadlines.cleanupEpochMs + 2);
  assert.ok(Math.abs(child.deadlines.primaryEpochMs - run.deadlines.primaryEpochMs) <= 2);
  assert.ok(child.deadlines.primaryEpochMs <= child.deadlines.cleanupEpochMs - 7_000 + 2);
});

test('a nested observer rejects admission when its inherited cleanup cutoff is expired', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'nested-expired', budgetMs: 2000});
  const sentinel = path.join(run.outputDir, 'nested-child-started');
  const observer = new URL('../harness-observation.mjs', import.meta.url).href;
  const source = `
    import {createRunContext} from ${JSON.stringify(observer)};
    const child = await createRunContext({output: process.argv[1], budgetMs: 1000});
    const result = await child.runCommand(process.execPath,
      ['-e', "require('node:fs').writeFileSync(process.argv[1], 'started')", process.argv[2]])
      .then(() => 'unexpected-success', error => error.record.outcome);
    console.log(JSON.stringify({outcome: result}));
  `;
  const result = await run.runCommand(process.execPath, ['--input-type=module', '-e', source, run.outputDir, sentinel], {
    phase: 'whole', timeout: 1200,
    env: {...process.env, QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS: '1'},
  });
  assert.equal(JSON.parse(result.stdout).outcome, 'deadline-expired-before-spawn');
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});

test('an expired whole deadline cannot publish a successful terminal manifest', async t => {
  const previous = process.env.QRCLIP_HARNESS_DEADLINE_EPOCH_MS;
  t.after(() => {
    if (previous === undefined) delete process.env.QRCLIP_HARNESS_DEADLINE_EPOCH_MS;
    else process.env.QRCLIP_HARNESS_DEADLINE_EPOCH_MS = previous;
  });
  process.env.QRCLIP_HARNESS_DEADLINE_EPOCH_MS = '1';
  const run = await createRunContext({output: await fixture(t), budgetMs: 1000});
  run.setPrimary({passed: true});
  const terminal = await run.finalize();
  const manifest = JSON.parse(await readFile(terminal.manifestPath, 'utf8'));
  assert.equal(terminal.ok, false);
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.failures.publication[0].kind, 'whole-deadline-expired');
});

test('pre-aborted signals reject before spawning a child', async t => {
  const run = await createRunContext({
    output: await fixture(t),
    scenario: 'cancelled-before-spawn',
    budgetMs: 1000,
    primaryMs: 700,
  });
  const sentinel = path.join(run.outputDir, 'child-started');
  const [command, args] = nodeScript("require('node:fs').writeFileSync(process.argv[1],'started')");
  args.push(sentinel);
  const controller = new AbortController();
  controller.abort();
  let spawned = false;

  const outcome = await run.runCommand(command, args, {
    signal: controller.signal,
    onSpawn: () => { spawned = true; },
  }).then(value => ({value}), error => ({error}));
  assert.equal(spawned, false);
  assert.ok(outcome.error instanceof Error);
  assert.equal(outcome.error.cancelled, true);
  assert.equal(outcome.error.record.outcome, 'cancelled-before-spawn');
  assert.equal(outcome.error.record.exit, undefined);
  assert.equal(outcome.error.record.close, undefined);
  await assert.rejects(readFile(sentinel), {code: 'ENOENT'});
});

test('sanitized persistence redacts output while exec-compatible output stays raw', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'streams', budgetMs: 2000});
  const [command, args] = nodeScript([
    "process.stdout.write(Buffer.from([0x74,0x6f,0x6b,0x65,0x6e,0x3d,0x73,0x75]));",
    "setImmediate(()=>process.stdout.write(Buffer.from([0x70,0x65,0x72,0x53,0x65,0x63,0x72,0x65,0x74,0x20,0x63,0x61,0x66,0xc3])));",
    "setImmediate(()=>setImmediate(()=>{process.stdout.write(Buffer.from([0xa9,0x0a]));process.stderr.write('warning: ok\\n')}));",
  ].join(''));
  const result = await run.runCommand(command, args, {
    label: 'fixture-child',
    timeout: 1500,
    sanitize: line => line.replace(/token=\S+/, 'token=[redacted]'),
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'token=superSecret café\n');
  assert.equal(result.stderr, 'warning: ok\n');
  assert.equal(result.record.exit.code, 0);
  assert.equal(result.record.close.code, 0);
  assert.deepEqual(result.record.eof, {stdout: true, stderr: true});
  const savedOut = await readFile(path.join(run.outputDir, result.record.artifacts.stdout), 'utf8');
  assert.equal(savedOut.includes('superSecret'), false);
  const outputMetadata = result.record.artifactMetadata.stdout;
  assert.equal(outputMetadata.sizeBytes, Buffer.byteLength(savedOut));
  assert.equal(outputMetadata.sha256, createHash('sha256').update(savedOut).digest('hex'));
  assert.equal(outputMetadata.sanitized, true);
  assert.equal(outputMetadata.redacted, true);
  assert.equal(outputMetadata.truncated, false);
  assert.equal(outputMetadata.partial, false);
});

test('configured nonzero exit code is accepted by command and run finalization', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'accepted-exit', budgetMs: 1200});
  run.setPrimary({passed: true});
  const [command, args] = nodeScript('process.exit(1)');
  const result = await run.runCommand(command, args, {
    phase: 'whole',
    expectedExitCodes: [0, 1],
  });
  const report = await run.finalize({cleanupVerified: true});

  assert.equal(result.code, 1);
  assert.equal(result.record.outcome, 'exit');
  assert.deepEqual(result.record.expectedExitCodes, [0, 1]);
  assert.equal(report.ok, true);
  assert.equal(report.commands[0].code, 1);
});

test('unexpected nonzero exit code fails command and run finalization', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'unexpected-exit', budgetMs: 1200});
  run.setPrimary({passed: true});
  const [command, args] = nodeScript('process.exit(1)');
  await assert.rejects(run.runCommand(command, args, {phase: 'whole'}), error => {
    assert.equal(error.code, 1);
    assert.equal(error.record.outcome, 'exit');
    assert.deepEqual(error.record.expectedExitCodes, [0]);
    assert.equal(error.record.exit.code, 1);
    return true;
  });
  const report = await run.finalize({cleanupVerified: true});

  assert.equal(report.ok, false);
  assert.equal(report.firstFailure.kind, 'ObservationError');
  assert.equal(report.commands[0].code, 1);
});

test('unclassified output is suppressed while byte counts remain observable', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'private', budgetMs: 1500});
  const [command, args] = nodeScript("process.stdout.write('private payload\\n');process.stderr.write('credential\\n')");
  const result = await run.runCommand(command, args, {timeout: 1000});

  assert.equal(result.stdout, 'private payload\n');
  assert.equal(result.stderr, 'credential\n');
  assert.equal(result.record.captureClass, 'suppressed');
  assert.deepEqual(result.record.diagnostic, {status: 'unavailable', reason: 'adapter-not-configured'});
  assert.ok(result.record.bytes.stdout > 0);
  assert.equal(result.record.artifacts.stdout, undefined);
  const manifest = await readFile(path.join(run.outputDir, 'manifest.json'), 'utf8');
  assert.equal(manifest.includes('private payload'), false);
  assert.equal(manifest.includes('credential'), false);
});

test('stream overflow and oversized unterminated lines are bounded and reported', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'limits', budgetMs: 2000});
  const [command, args] = nodeScript("process.stdout.write('ok\\n'+'x'.repeat(4000));process.stderr.write('y'.repeat(4000))");
  const result = await run.runCommand(command, args, {
    timeout: 1500,
    maxBytesPerStream: 5000,
    maxLineBytes: 64,
    maxTailBytes: 24,
    sanitize: line => line,
  });

  assert.equal(result.stdout, `ok\n${'x'.repeat(4000)}`);
  assert.equal(result.stderr, 'y'.repeat(4000));
  assert.ok(result.record.droppedBytes.stdout > 0);
  assert.ok(result.record.droppedBytes.stderr > 0);
  assert.equal(result.record.truncated.stdout, true);
  assert.equal(result.record.truncated.stderr, true);
  assert.ok(result.record.rawBytes.stdout <= 5000);
  const retainedLine = await readFile(path.join(run.outputDir, result.record.artifacts.stdout), 'utf8');
  assert.equal(retainedLine, 'ok\n');
  assert.equal(result.record.artifactMetadata.stdout.sizeBytes, Buffer.byteLength(retainedLine));
  assert.equal(result.record.artifactMetadata.stdout.truncated, true);
  assert.equal(result.record.artifactMetadata.stdout.partial, true);
  assert.equal(result.record.artifacts.stderr, undefined);
});

test('sanitized lines and events are visible on disk before child termination', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'live-evidence', budgetMs: 1000});
  const [command, args] = nodeScript("process.stdout.write('safe live line\\n');setInterval(()=>{},1000)");
  let observed;
  let child;
  const visible = new Promise((resolve, reject) => {
    observed = {resolve, reject};
  });
  const pending = run.runCommand(command, args, {
    timeout: 240,
    diagnosticMs: 60,
    sanitize: line => line,
    onSpawn: spawned => {
      child = spawned;
      child.stdout.on('data', async () => {
        try {
          const log = await readFile(path.join(run.outputDir, 'command-1-stdout.safe.log'), 'utf8');
          const events = await readFile(path.join(run.outputDir, 'events.jsonl'), 'utf8');
          assert.equal(log, 'safe live line\n');
          assert.ok(events.includes('"type":"output-line"'));
          assert.equal(child.exitCode, null);
          observed.resolve();
        } catch (error) {
          observed.reject(error);
        }
      });
    },
  });
  const rejected = assert.rejects(pending, error => error.timedOut === true);

  await visible;
  await rejected;
});

test('raw overflow fails instead of returning successful truncated adapter data', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'raw-overflow', budgetMs: 1500});
  const [command, args] = nodeScript("process.stdout.write(Buffer.from([0xff,0x00,...Buffer.alloc(3000,0x61)]))");

  await assert.rejects(run.runCommand(command, args, {
    timeout: 1000,
    maxBuffer: 512,
    encoding: 'buffer',
  }), error => {
    assert.equal(error.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
    assert.ok(Buffer.isBuffer(error.stdout));
    assert.ok(error.stdout.length <= 512);
    assert.equal(error.record.outcome, 'output-overflow');
    assert.equal(error.record.rawDroppedBytes.stdout > 0, true);
    return true;
  });
});

test('binary adapter output is returned as a bounded Buffer without persistence', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'binary', budgetMs: 1500});
  const [command, args] = nodeScript("process.stdout.write(Buffer.from([0xff,0x00,0x80]))");
  const result = await run.runCommand(command, args, {timeout: 1000, encoding: 'buffer'});

  assert.deepEqual(result.stdout, Buffer.from([0xff, 0x00, 0x80]));
  assert.equal(result.record.artifacts.stdout, undefined);
});

test('silent timeout invokes its bounded diagnostic before terminating the child', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'timeout', budgetMs: 1000});
  const [command, args] = nodeScript('setInterval(()=>{},1000)');
  let child;
  let diagnosticSawLiveChild = false;
  const pending = run.runCommand(command, args, {
    timeout: 240,
    diagnosticMs: 80,
    onSpawn: spawned => { child = spawned; },
    diagnostic: ({snapshot, deadlineMs, signal}) => {
      diagnosticSawLiveChild = child.killed === false && snapshot.bytes.stdout === 0;
      assert.ok(deadlineMs > 0);
      assert.equal(signal.aborted, false);
      return {observed: true};
    },
  });

  assert.ok(child, 'onSpawn must run synchronously before runCommand yields');
  await assert.rejects(pending, error => {
    assert.equal(error.timedOut, true);
    assert.equal(error.record.outcome, 'timeout');
    return true;
  });
  assert.equal(diagnosticSawLiveChild, true);
});

test('whole phase reserves termination inside its hard deadline', async t => {
  const run = await createRunContext({
    output: await fixture(t),
    scenario: 'bounded-termination',
    budgetMs: 800,
    primaryMs: 400,
    cleanupMs: 100,
    publicationMs: 100,
  });
  const [command, args] = nodeScript("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)");
  const pending = run.runCommand(command, args, {phase: 'whole'});
  let error;
  await assert.rejects(pending, value => {
    error = value;
    return value.timedOut === true;
  });

  const record = error.record;
  assert.equal(record.outcome, 'timeout');
  assert.ok(record.deadlines.workElapsedMs < record.deadlines.hardElapsedMs);
  assert.ok(Math.abs(
    record.deadlines.hardElapsedMs - record.deadlines.workElapsedMs - record.deadlines.terminationReserveMs,
  ) <= 1);
  assert.ok(record.termination.sigtermElapsedMs >= record.deadlines.workElapsedMs - 2);
  assert.ok(record.termination.sigkillElapsedMs <= record.deadlines.hardElapsedMs + 100);
  assert.ok(record.terminalElapsedMs <= record.deadlines.hardElapsedMs + 120);
});

test('missing executable exposes spawn error without fabricating exit or close', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'spawn-error', budgetMs: 1500});

  await assert.rejects(
    run.runCommand(path.join(run.outputDir, 'missing-executable'), [], {timeout: 1000}),
    error => {
      assert.equal(error.code, 'ENOENT');
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, '');
      assert.equal(error.record.outcome, 'spawn-error');
      assert.equal(error.record.exit, undefined);
      assert.deepEqual(error.record.close, {code: -2, signal: null});
      assert.equal(error.record.spawnError.kind, 'Error');
      return true;
    },
  );
});

test('exit with a descendant-held pipe remains distinct from close and EOF', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'held-pipe', budgetMs: 1200});
  const pidFile = path.join(run.outputDir, 'descendant.pid');
  const source = [
    "const {spawn}=require('node:child_process');",
    "const {writeFileSync}=require('node:fs');",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});",
    "writeFileSync(process.argv[1],String(child.pid));",
    'process.exit(0);',
  ].join('');
  const [command, args] = nodeScript(source);
  args.push(pidFile);
  let descendantPid;
  try {
    await assert.rejects(run.runCommand(command, args, {timeout: 180, terminationGraceMs: 20}), error => {
      assert.equal(error.record.outcome, 'timeout');
      assert.equal(error.record.exit.code, 0);
      assert.equal(error.record.close, undefined);
      assert.deepEqual(error.record.eof, {stdout: false, stderr: false});
      return true;
    });
    descendantPid = Number(await readFile(pidFile, 'utf8'));
  } finally {
    if (descendantPid > 0) {
      try { process.kill(descendantPid, 'SIGKILL'); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
  }
});

test('EOF while the child remains alive does not become an exit receipt', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'eof-alive', budgetMs: 1000});
  const [command, args] = nodeScript("process.stdout.end();process.stderr.end();setInterval(()=>{},1000)");
  await assert.rejects(run.runCommand(command, args, {timeout: 120, terminationGraceMs: 20}), error => {
    assert.equal(error.record.outcome, 'timeout');
    assert.deepEqual(error.record.exit, {code: null, signal: 'SIGTERM'});
    assert.deepEqual(error.record.close, {code: null, signal: 'SIGTERM'});
    assert.deepEqual(error.record.eof, {stdout: true, stderr: true});
    return true;
  });
});

test('cancellation terminates only the direct child and records cancellation', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'cancel', budgetMs: 1200});
  const [command, args] = nodeScript('setInterval(()=>{},1000)');
  const controller = new AbortController();
  let spawned = false;
  const pending = run.runCommand(command, args, {
    timeout: 1000,
    signal: controller.signal,
    onSpawn: () => {
      spawned = true;
      setImmediate(() => controller.abort());
    },
  });

  assert.equal(spawned, true);
  await assert.rejects(pending, error => {
    assert.equal(error.cancelled, true);
    assert.equal(error.record.outcome, 'cancelled');
    return true;
  });
});

test('late diagnostic replies cannot change the frozen command record', async t => {
  const run = await createRunContext({output: await fixture(t), scenario: 'late-diagnostic', budgetMs: 1200});
  const [command, args] = nodeScript('setInterval(()=>{},1000)');
  let releaseDiagnostic;
  let diagnosticEntered;
  let acknowledgeLateReply;
  const entered = new Promise(resolve => { diagnosticEntered = resolve; });
  const lateReplyAcknowledged = new Promise(resolve => { acknowledgeLateReply = resolve; });
  const held = new Promise(resolve => { releaseDiagnostic = resolve; });
  let terminalError;
  const pending = run.runCommand(command, args, {
    timeout: 160,
    diagnosticMs: 60,
    diagnostic: () => {
      diagnosticEntered();
      return held.then(value => {
        setImmediate(acknowledgeLateReply);
        return value;
      });
    },
  });

  await entered;
  await assert.rejects(pending, error => {
    terminalError = error;
    assert.equal(Object.isFrozen(error.record), true);
    assert.equal(error.record.diagnostic.status, 'incomplete');
    return true;
  });
  const terminalRecord = JSON.stringify(terminalError.record);
  const report = await run.finalize({cleanupVerified: true});
  const terminalManifest = await readFile(report.manifestPath, 'utf8');
  releaseDiagnostic({secret: 'late-private-result'});
  await lateReplyAcknowledged;
  const lateRecord = JSON.stringify(terminalError.record);
  const lateManifest = await readFile(report.manifestPath, 'utf8');
  assert.equal(lateRecord, terminalRecord);
  assert.equal(lateManifest, terminalManifest);
  assert.equal(terminalRecord.includes('late-private-result'), false);
  assert.equal(terminalManifest.includes('late-private-result'), false);
  assert.equal(report.ok, false);
});

test('publication failure remains separate and keeps the first primary failure', async t => {
  const root = await fixture(t);
  const run = await createRunContext({output: root, scenario: 'publication', budgetMs: 1200});
  const moved = `${run.outputDir}.moved`;
  await rename(run.outputDir, moved);
  await writeFile(run.outputDir, 'block publication');
  run.setPrimary({passed: false, error: Object.assign(new Error('secret primary message'), {code: 'FIRST'})});
  run.setPrimary({passed: true});
  const report = await run.finalize({
    cleanupErrors: [],
    publicationErrors: [],
    cleanupVerified: true,
  });

  assert.equal(report.ok, false);
  assert.equal(report.firstFailure.kind, 'Error');
  assert.equal(report.firstFailure.code, 'FIRST');
  assert.deepEqual(report.failures.cleanup, []);
  assert.ok(report.failures.publication.length > 0);
  assert.equal(JSON.stringify(report).includes('secret primary message'), false);
  await rm(run.outputDir, {force: true});
  await rename(moved, run.outputDir);
});

test('whole phase stops before its publication reserve and exposes a frozen success record', async t => {
  const run = await createRunContext({
    output: await fixture(t),
    scenario: 'whole-phase',
    budgetMs: 1000,
    primaryMs: 500,
    cleanupMs: 100,
    publicationMs: 100,
  });
  run.phase('scenario', 'started', {endpoint: 'phoneA'});
  run.setPrimary({passed: true});
  const [command, args] = nodeScript("process.stdout.write('scenario-report\\n')");
  let callbackPid;
  const result = await run.runCommand(command, args, {
    phase: 'whole',
    timeout: 800,
    onSpawn: child => { callbackPid = child.pid; },
  });
  const report = await run.finalize({cleanupVerified: true});

  assert.equal(result.stdout, 'scenario-report\n');
  assert.equal(result.code, 0);
  assert.equal(result.record.label, path.basename(command));
  assert.ok(callbackPid > 0);
  assert.equal(report.ok, true);
  assert.equal(Object.isFrozen(report), true);
});
