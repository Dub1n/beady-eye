// allow: SIZE_OK — The existing report and deadline recorder is ported as one assigned module.
/**
 * Small, platform-neutral run recorder and child-process observer.
 *
 * Public API:
 *   const run = await createRunContext({
 *     output, scenario, budgetMs, primaryMs, cleanupMs, publicationMs,
 *   });
 *   run.phase(name, state, details?);
 *   run.setPrimary({passed, error});
 *   await run.runCommand(command, args, {
 *     timeout, phase: 'whole' | 'primary' | 'cleanup' | 'diagnostic',
 *     expectedExitCodes (defaults to [0]), signal, sanitize, label,
 *     diagnostic, diagnosticMs,
 *     env, cwd, encoding, onSpawn,
 *   });
 *   const report = await run.finalize({cleanupErrors, publicationErrors, cleanupVerified});
 *
 * A run creates a unique private subdirectory and writes an initial incomplete
 * manifest before returning. If QRCLIP_HARNESS_OUTPUT is set, child evidence
 * goes in a unique child directory and never replaces the parent's manifest.
 * Absolute parent deadlines in QRCLIP_HARNESS_DEADLINE_EPOCH_MS,
 * QRCLIP_HARNESS_PRIMARY_DEADLINE_EPOCH_MS, and
 * QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS are converted once to monotonic
 * deadlines. This module observes and terminates only the direct spawned child;
 * process-tree/platform cleanup belongs to the platform adapter.
 *
 * Bounded raw stdout/stderr are returned in memory for the owning adapter and
 * never persisted. `encoding: 'buffer'` returns Buffers. Raw overflow fails
 * the command. Persistence requires a line sanitizer; complete, bounded lines
 * and events append synchronously while the child runs. A line exceeding its
 * cap is dropped whole.
 */
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {mkdir, rename, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {performance} from 'node:perf_hooks';

const DEFAULTS = Object.freeze({
  budgetMs: 120_000,
  cleanupBudgetMs: 10_000,
  publicationReserveMs: 2_000,
  diagnosticWindowMs: 5_000,
  maxBytesPerStream: 4 * 1024 * 1024,
  maxTailBytes: 64 * 1024,
  maxLineBytes: 64 * 1024,
  maxEventBytes: 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
});
const SCHEMA_VERSION = 1;
const STREAMS = ['stdout', 'stderr'];

class ObservationError extends Error {
  constructor(message, details = {}) {
    super(message, details.cause ? {cause: details.cause} : undefined);
    this.name = 'ObservationError';
    Object.assign(this, details);
  }
}

const boundedNumber = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${name} must be a finite non-negative number`);
  return Math.floor(value);
};

const safeLabel = (value, fallback = 'unknown') => {
  if (typeof value !== 'string') return fallback;
  const label = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 80);
  return label || fallback;
};

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

const envDeadline = (name, startMono, wallNow) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const epoch = Number(raw);
  if (!Number.isFinite(epoch)) throw new TypeError(`${name} must contain an epoch-millisecond deadline`);
  return startMono + Math.max(0, epoch - wallNow);
};

const relativeDeadline = (startMono, budgetMs, inherited) => {
  const local = startMono + budgetMs;
  return inherited === undefined ? local : Math.min(local, inherited);
};

const errorCode = error => error && typeof error === 'object' && 'code' in error
  ? safeLabel(String(error.code))
  : undefined;

const summarizeFailure = (value, fallbackKind) => {
  if (value instanceof Error) {
    return {
      kind: safeLabel(value.name, fallbackKind),
      ...(errorCode(value) ? {code: errorCode(value)} : {}),
      ...(value instanceof ObservationError && typeof value.kind === 'string'
        ? {reason: safeLabel(value.kind, fallbackKind)} : {}),
    };
  }
  if (value && typeof value === 'object') {
    return {
      kind: safeLabel(typeof value.kind === 'string' ? value.kind : fallbackKind, fallbackKind),
      ...(typeof value.code === 'string' ? {code: safeLabel(value.code)} : {}),
    };
  }
  return {kind: fallbackKind};
};

export async function createRunContext(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('createRunContext options must be an object');
  }

  const binding = {
    nonce: process.env.QRCLIP_WORK_CHECK_NONCE,
    id: process.env.QRCLIP_AGENT_WORK_ID,
    attempt: process.env.QRCLIP_WORK_CHECK_ATTEMPT,
  };
  const hasCheckBinding = binding.nonce !== undefined || binding.attempt !== undefined;
  if (hasCheckBinding && Object.values(binding).some(value => typeof value !== 'string' || !value.trim())) {
    throw new TypeError('Work check binding requires nonce, work id and attempt together');
  }
  const workCheck = hasCheckBinding ? Object.freeze(binding) : undefined;
  const startMono = performance.now();
  const wallNow = Date.now();
  const budgetMs = boundedNumber(options.budgetMs, DEFAULTS.budgetMs, 'budgetMs');
  const cleanupBudgetMs = boundedNumber(
    options.cleanupMs ?? options.cleanupBudgetMs,
    Math.min(DEFAULTS.cleanupBudgetMs, Math.floor(budgetMs / 10)),
    'cleanupMs',
  );
  const publicationReserveMs = boundedNumber(
    options.publicationMs ?? options.publicationReserveMs,
    Math.min(DEFAULTS.publicationReserveMs, Math.floor(budgetMs / 20)),
    'publicationMs',
  );
  const diagnosticWindowMs = boundedNumber(options.diagnosticWindowMs, DEFAULTS.diagnosticWindowMs, 'diagnosticWindowMs');
  const primaryBudgetMs = boundedNumber(
    options.primaryMs ?? options.primaryBudgetMs,
    Math.max(0, budgetMs - cleanupBudgetMs - publicationReserveMs),
    'primaryBudgetMs',
  );
  if (primaryBudgetMs + cleanupBudgetMs + publicationReserveMs > budgetMs) {
    throw new RangeError('primary, cleanup, and publication partitions exceed budgetMs');
  }
  const inheritedWhole = envDeadline('QRCLIP_HARNESS_DEADLINE_EPOCH_MS', startMono, wallNow);
  const inheritedPrimary = envDeadline('QRCLIP_HARNESS_PRIMARY_DEADLINE_EPOCH_MS', startMono, wallNow);
  const inheritedCleanup = envDeadline('QRCLIP_HARNESS_CLEANUP_DEADLINE_EPOCH_MS', startMono, wallNow);
  const wholeDeadline = relativeDeadline(startMono, budgetMs, inheritedWhole);
  const publicationDeadline = Math.max(startMono, wholeDeadline - publicationReserveMs);
  const cleanupDeadline = Math.min(
    relativeDeadline(startMono, budgetMs, inheritedCleanup),
    publicationDeadline,
  );
  const primaryDeadline = Math.min(
    relativeDeadline(startMono, primaryBudgetMs, inheritedPrimary),
    cleanupDeadline - cleanupBudgetMs,
  );
  const effectivePrimaryDeadline = Math.max(startMono, primaryDeadline);
  const effectiveCleanupDeadline = Math.max(startMono, cleanupDeadline);
  const parentOutput = options.output ?? options.outputDir ?? process.env.QRCLIP_HARNESS_OUTPUT;
  const root = parentOutput ? path.resolve(parentOutput) : os.tmpdir();
  await mkdir(root, {recursive: true, mode: 0o700});
  const runId = randomUUID();
  const {mkdtemp} = await import('node:fs/promises');
  const outputDir = await mkdtemp(path.join(root, `qrclip-observation-${runId}-`));
  await chmodPrivate(outputDir);

  const state = {
    runId,
    scenario: safeLabel(options.scenario),
    endpoint: options.endpoint === undefined ? undefined : safeLabel(options.endpoint),
    outputDir,
    startMono,
    wholeDeadline,
    primaryDeadline: effectivePrimaryDeadline,
    cleanupDeadline: effectiveCleanupDeadline,
    publicationDeadline,
    events: [],
    eventBytes: 0,
    totalEvidenceBytes: 0,
    totalRawBytes: 0,
    commandSequence: 0,
    eventSequence: 0,
    phaseName: 'initializing',
    primary: undefined,
    primaryFailure: undefined,
    failures: {primary: [], diagnostic: [], termination: [], cleanup: [], publication: []},
    commands: [],
    finalized: false,
    terminal: undefined,
    published: false,
  };

  const elapsed = () => Math.max(0, performance.now() - startMono);
  const remaining = deadline => Math.max(0, deadline - performance.now());
  const relativePath = filename => path.relative(outputDir, filename).split(path.sep).join('/');
  let publicationChain = Promise.resolve();

  const manifest = () => ({
    schemaVersion: SCHEMA_VERSION,
    runId,
    ...(workCheck ? {workCheck} : {}),
    scenario: state.scenario,
    ...(state.endpoint ? {endpoint: state.endpoint} : {}),
    status: state.finalized ? (isSuccessful() ? 'complete' : 'failed') : 'incomplete',
    createdAt: new Date(wallNow).toISOString(),
    elapsedMs: Math.round(elapsed()),
    deadlines: {
      budgetMs,
      primaryRemainingMsAtStart: Math.round(remaining(effectivePrimaryDeadline)),
      cleanupRemainingMsAtStart: Math.round(remaining(effectiveCleanupDeadline)),
      publicationReserveMs,
      inherited: {
        whole: inheritedWhole !== undefined,
        primary: inheritedPrimary !== undefined,
        cleanup: inheritedCleanup !== undefined,
      },
    },
    phase: state.phaseName,
    primary: state.primary,
    firstFailure: state.primaryFailure,
    failures: state.failures,
    commands: state.commands,
    events: state.events,
    eventsPath: 'events.jsonl',
  });

  function isSuccessful() {
    return state.primary?.ok === true
      && state.primaryFailure === undefined
      && Object.values(state.failures).every(failures => failures.length === 0)
      && state.commands.every(command => command.outcome === 'exit' && command.expectedExitCodes.includes(command.code)
        && command.eof.stdout && command.eof.stderr);
  }

  async function atomicJson(filename, value) {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600, flag: 'wx'});
      await rename(temporary, filename);
    } catch (error) {
      await rm(temporary, {force: true}).catch(() => {});
      throw error;
    }
  }

  function recordFailure(category, error, kind) {
    const failure = summarizeFailure(error, kind);
    const entries = state.failures[category];
    if (entries.length < 64) entries.push(failure);
    if (category === 'primary' && state.primaryFailure === undefined) {
      state.primaryFailure = deepFreeze({...failure});
    }
    return failure;
  }

  function addEvent(type, fields = {}) {
    const event = {
      sequence: ++state.eventSequence,
      elapsedMs: Math.round(elapsed() * 1000) / 1000,
      type: safeLabel(type),
      phase: state.phaseName,
      ...fields,
    };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > DEFAULTS.maxEventBytes || state.eventBytes + bytes > DEFAULTS.maxEventBytes) return false;
    try {
      appendFileSync(path.join(outputDir, 'events.jsonl'), `${JSON.stringify(event)}\n`, {mode: 0o600});
    } catch (error) {
      recordFailure('publication', error, 'event-publication-failed');
      return false;
    }
    state.events.push(event);
    state.eventBytes += bytes;
    return true;
  }

  async function publish() {
    publicationChain = publicationChain.then(async () => {
      try {
        await atomicJson(path.join(outputDir, 'manifest.json'), manifest());
        state.published = true;
        return true;
      } catch (error) {
        recordFailure('publication', error, 'publication-failed');
        return false;
      }
    });
    return publicationChain;
  }

  function phase(name, phaseState = 'entered', details = {}) {
    if (state.finalized) throw new ObservationError('run context is finalized', {kind: 'finalized'});
    state.phaseName = safeLabel(name, 'unnamed');
    if (phaseState && typeof phaseState === 'object') {
      details = phaseState;
      phaseState = 'entered';
    }
    const safeDetails = {};
    for (const [key, value] of Object.entries(details ?? {})) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key)) continue;
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) {
        safeDetails[key] = value;
      } else if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) {
        safeDetails[key] = value;
      }
    }
    addEvent('phase', {name: state.phaseName, state: safeLabel(phaseState), details: safeDetails});
    void publish();
    return state.phaseName;
  }

  function setPrimary(result) {
    if (state.finalized) throw new ObservationError('run context is finalized', {kind: 'finalized'});
    if (state.primary !== undefined) return state.primary;
    if (!result || typeof result !== 'object') throw new TypeError('primary result must be an object');
    const ok = result.passed === true || result.ok === true;
    state.primary = deepFreeze({
      ok,
      ...(typeof result.kind === 'string' ? {kind: safeLabel(result.kind)} : {}),
      ...(typeof result.code === 'string' ? {code: safeLabel(result.code)} : {}),
    });
    if (!ok) recordFailure('primary', result.error ?? result, 'primary-failed');
    addEvent('primary-terminal', {ok});
    void publish();
    return state.primary;
  }

  const context = {
    runId,
    workCheck,
    outputDir,
    deadlines: deepFreeze({
      startedAtEpochMs: wallNow,
      wholeEpochMs: wallNow + Math.max(0, wholeDeadline - startMono),
      primaryEpochMs: wallNow + Math.max(0, effectivePrimaryDeadline - startMono),
      cleanupEpochMs: wallNow + Math.max(0, effectiveCleanupDeadline - startMono),
      remaining: () => deepFreeze({
        wholeMs: Math.floor(remaining(wholeDeadline)),
        primaryMs: Math.floor(remaining(effectivePrimaryDeadline)),
        cleanupMs: Math.floor(remaining(effectiveCleanupDeadline)),
      }),
    }),
    phase,
    setPrimary,
    runCommand: async (command, args = [], commandOptions = {}) => {
      if (state.finalized) throw new ObservationError('run context is finalized', {kind: 'finalized'});
      if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args)
        || args.some(argument => typeof argument !== 'string')) {
        throw new TypeError('runCommand requires a command string and string argument array');
      }
      const roleValue = commandOptions.phase ?? commandOptions.role;
      const expectedExitCodes = commandOptions.expectedExitCodes ?? [0];
      if (!Array.isArray(expectedExitCodes) || expectedExitCodes.length === 0 ||
          expectedExitCodes.some(code => !Number.isInteger(code) || code < 0 || code > 255)) {
        throw new TypeError('expectedExitCodes must be a nonempty array of process exit codes');
      }
      const role = ['whole', 'primary', 'diagnostic', 'cleanup'].includes(roleValue)
        ? roleValue
        : 'primary';
      const capMs = boundedNumber(commandOptions.timeout ?? commandOptions.timeoutMs, Number.MAX_SAFE_INTEGER, 'timeout');
      const phaseDeadline = role === 'cleanup' ? effectiveCleanupDeadline
        : role === 'whole' ? publicationDeadline : effectivePrimaryDeadline;
      const commandStartedMono = performance.now();
      const commandDeadline = Math.min(phaseDeadline, commandStartedMono + capMs);
      const requestedTerminationGraceMs = boundedNumber(commandOptions.terminationGraceMs, 250, 'terminationGraceMs');
      const requestedPipeCloseMs = boundedNumber(commandOptions.pipeCloseMs, 100, 'pipeCloseMs');
      const terminationReserveMs = Math.min(
        requestedTerminationGraceMs + requestedPipeCloseMs,
        Math.floor(Math.max(0, commandDeadline - commandStartedMono) / 4),
      );
      const workDeadline = commandDeadline - terminationReserveMs;
      const requestedDiagnosticWindowMs = boundedNumber(
        commandOptions.diagnosticMs ?? commandOptions.diagnosticWindowMs,
        diagnosticWindowMs,
        'diagnosticMs',
      );
      const diagnosticWindow = Math.min(
        requestedDiagnosticWindowMs,
        Math.max(0, workDeadline - commandStartedMono),
      );
      const maxBytesPerStream = Math.min(
        DEFAULTS.maxBytesPerStream,
        boundedNumber(commandOptions.maxBytesPerStream, DEFAULTS.maxBytesPerStream, 'maxBytesPerStream'),
      );
      const maxRawBytesPerStream = Math.min(
        maxBytesPerStream,
        boundedNumber(commandOptions.maxBuffer, maxBytesPerStream, 'maxBuffer'),
      );
      const maxTailBytes = boundedNumber(commandOptions.maxTailBytes, DEFAULTS.maxTailBytes, 'maxTailBytes');
      const maxLineBytes = boundedNumber(commandOptions.maxLineBytes, DEFAULTS.maxLineBytes, 'maxLineBytes');
      const maxTotalBytes = Math.min(
        DEFAULTS.maxTotalBytes,
        boundedNumber(commandOptions.maxTotalBytes, DEFAULTS.maxTotalBytes, 'maxTotalBytes'),
      );
      const sanitizer = commandOptions.sanitize ?? commandOptions.sanitizeLine;
      const captureEnabled = typeof sanitizer === 'function';
      const index = ++state.commandSequence;
      const commandId = `command-${index}`;
      const commandRecord = {
        id: commandId,
        label: safeLabel(commandOptions.label, path.basename(command)),
        role,
        expectedExitCodes: [...new Set(expectedExitCodes)],
        outcome: 'running',
        startedElapsedMs: Math.round(elapsed()),
        effectiveTimeoutMs: Math.max(0, Math.floor(commandDeadline - commandStartedMono)),
        deadlines: {
          workElapsedMs: Math.round(workDeadline - startMono),
          hardElapsedMs: Math.round(commandDeadline - startMono),
          terminationReserveMs,
        },
        termination: {
          requestedElapsedMs: undefined,
          sigtermElapsedMs: undefined,
          sigkillElapsedMs: undefined,
          pipesClosedElapsedMs: undefined,
        },
        captureClass: captureEnabled ? 'safe-sanitized' : 'suppressed',
        bytes: {stdout: 0, stderr: 0},
        rawBytes: {stdout: 0, stderr: 0},
        rawDroppedBytes: {stdout: 0, stderr: 0},
        retainedBytes: {stdout: 0, stderr: 0},
        droppedBytes: {stdout: 0, stderr: 0},
        eof: {stdout: false, stderr: false},
        truncated: {stdout: false, stderr: false},
        artifacts: {},
        artifactMetadata: {},
        diagnostic: typeof commandOptions.diagnostic === 'function'
          ? {status: 'configured'}
          : {status: 'unavailable', reason: 'adapter-not-configured'},
        exit: undefined,
        close: undefined,
        spawnError: undefined,
      };
      state.commands.push(commandRecord);
      addEvent('command-start', {commandId, label: commandRecord.label, role});
      void publish();

      const encoding = commandOptions.encoding ?? 'utf8';
      const signal = commandOptions.signal;
      const cancelledBeforeSpawn = signal?.aborted === true;
      const expiredBeforeSpawn = !cancelledBeforeSpawn && performance.now() >= workDeadline;
      if (cancelledBeforeSpawn || expiredBeforeSpawn) {
        const reason = cancelledBeforeSpawn ? 'cancelled-before-spawn' : 'deadline-expired-before-spawn';
        const failure = new ObservationError('subprocess not started', {kind: reason});
        const category = role === 'cleanup' ? 'cleanup' : role === 'diagnostic' ? 'diagnostic' : 'primary';
        recordFailure(category, failure, reason);
        commandRecord.outcome = reason;
        commandRecord.terminalElapsedMs = Math.round(elapsed());
        commandRecord.code = null;
        commandRecord.signal = null;
        addEvent('command-terminal', {commandId, outcome: reason});
        await publish();
        const record = deepFreeze({...commandRecord});
        const emptyOutput = encoding === 'buffer' || encoding === null ? Buffer.alloc(0) : '';
        throw new ObservationError('subprocess rejected before spawn', {
          kind: reason,
          code: undefined,
          signal: undefined,
          stdout: emptyOutput,
          stderr: emptyOutput,
          record,
          capture: record,
          cancelled: cancelledBeforeSpawn,
          timedOut: expiredBeforeSpawn,
        });
      }

      const streamState = Object.fromEntries(STREAMS.map(stream => [stream, {
        line: Buffer.alloc(maxLineBytes),
        lineBytes: 0,
        overlong: false,
        seenBytes: 0,
        retainedBytes: 0,
        droppedBytes: 0,
        redactionApplied: false,
        tail: Buffer.alloc(0),
      }]));
      const rawChunks = {stdout: [], stderr: []};
      const persistedHashes = {
        stdout: createHash('sha256'),
        stderr: createHash('sha256'),
      };
      let spawnError;
      let exitReceipt;
      let closeReceipt;
      let done = false;
      let timedOut = false;
      let cancelled = false;
      let diagnosticStarted = false;
      let diagnosticTerminal;
      let diagnosticPromise;
      let diagnosticController;
      let termSignal;
      let terminationStarted = false;
      let settle;
      let settled = false;
      let terminationTimer;
      let forceTimer;
      const processClosed = new Promise(resolve => {
        settle = () => {
          if (settled) return;
          settled = true;
          clearTimeout(terminationTimer);
          clearTimeout(forceTimer);
          resolve();
        };
      });

      const snapshot = () => deepFreeze({
        commandId,
        outcome: commandRecord.outcome,
        exit: exitReceipt ? {...exitReceipt} : undefined,
        close: closeReceipt ? {...closeReceipt} : undefined,
        bytes: {...commandRecord.bytes},
        eof: {...commandRecord.eof},
        tails: Object.fromEntries(STREAMS.map(stream => [stream, streamState[stream].tail.toString('utf8')])),
        captured: captureEnabled,
      });

      function startDiagnostic(reason) {
        if (diagnosticStarted || typeof commandOptions.diagnostic !== 'function') return diagnosticPromise;
        diagnosticStarted = true;
        diagnosticController = new AbortController();
        const left = Math.max(0, Math.min(diagnosticWindow, workDeadline - performance.now()));
        const terminalSnapshot = snapshot();
        commandRecord.diagnostic = {status: 'started', reason: safeLabel(reason)};
        let result;
        try {
          result = commandOptions.diagnostic({
            snapshot: terminalSnapshot,
            deadlineMs: Math.floor(left),
            signal: diagnosticController.signal,
            reason,
          });
        } catch (error) {
          result = Promise.reject(error);
        }
        diagnosticPromise = Promise.resolve(result).then(value => {
          if (!done) {
            diagnosticTerminal = deepFreeze({ok: true, value: safeDiagnosticValue(value)});
            commandRecord.diagnostic = {status: 'complete', reason: safeLabel(reason)};
            addEvent('diagnostic-terminal', {commandId, ok: true});
          }
        }, error => {
          if (!done) {
            const failure = recordFailure('diagnostic', error, 'diagnostic-failed');
            diagnosticTerminal = deepFreeze({ok: false, failure});
            commandRecord.diagnostic = {status: 'failed', failure};
            addEvent('diagnostic-terminal', {commandId, ok: false});
          }
        });
        return diagnosticPromise;
      }

      function addTail(stream, bytes) {
        if (maxTailBytes === 0) return;
        const current = streamState[stream].tail;
        const joined = Buffer.concat([current, bytes]);
        streamState[stream].tail = joined.length > maxTailBytes ? joined.subarray(joined.length - maxTailBytes) : joined;
      }

      function collectLine(stream, lineBuffer) {
        if (!captureEnabled) return;
        let line;
        try {
          const decoder = new StringDecoder(
            encoding === 'buffer' || encoding === null ? 'utf8' : encoding,
          );
          line = decoder.end(lineBuffer);
        } catch {
          streamState[stream].droppedBytes += lineBuffer.length;
          return;
        }
        let safeLine;
        try {
          safeLine = sanitizer(line, {stream});
        } catch (error) {
          recordFailure('primary', error, 'sanitizer-failed');
          streamState[stream].droppedBytes += lineBuffer.length;
          return;
        }
        if (typeof safeLine !== 'string') {
          streamState[stream].droppedBytes += lineBuffer.length;
          return;
        }
        const safeBytes = Buffer.from(`${safeLine}\n`, 'utf8');
        const stateForStream = streamState[stream];
        if (stateForStream.retainedBytes + safeBytes.length > maxBytesPerStream
          || state.totalEvidenceBytes + safeBytes.length > maxTotalBytes) {
          stateForStream.droppedBytes += lineBuffer.length;
          return;
        }
        const filename = path.join(outputDir, `${commandId}-${stream}.safe.log`);
        try {
          appendFileSync(filename, safeBytes, {mode: 0o600});
          commandRecord.artifacts[stream] = relativePath(filename);
        } catch (error) {
          recordFailure('publication', error, 'stream-publication-failed');
          stateForStream.droppedBytes += lineBuffer.length;
          return;
        }
        stateForStream.retainedBytes += safeBytes.length;
        state.totalEvidenceBytes += safeBytes.length;
        persistedHashes[stream].update(safeBytes);
        stateForStream.redactionApplied ||= safeLine !== line;
        addTail(stream, safeBytes);
        commandRecord.artifactMetadata[stream] = {
          sizeBytes: stateForStream.retainedBytes,
          sha256: persistedHashes[stream].copy().digest('hex'),
          sanitized: true,
          redacted: stateForStream.redactionApplied,
          truncated: commandRecord.truncated[stream] || stateForStream.droppedBytes > 0,
          partial: true,
        };
        addEvent('output-line', {
          commandId,
          stream,
          bytes: safeBytes.length,
          text: safeLine.slice(0, Math.max(0, DEFAULTS.maxEventBytes - 256)),
        });
      }

      function consume(stream, chunk, final = false) {
        const record = streamState[stream];
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        record.seenBytes += bytes.length;
        commandRecord.bytes[stream] = record.seenBytes;
        const availableForStream = Math.max(0, maxRawBytesPerStream - (record.seenBytes - bytes.length));
        const availableForRun = Math.max(0, DEFAULTS.maxTotalBytes - state.totalRawBytes);
        const accepted = Math.min(bytes.length, availableForStream, availableForRun);
        commandRecord.rawBytes[stream] += accepted;
        commandRecord.rawDroppedBytes[stream] += bytes.length - accepted;
        if (bytes.length > accepted) commandRecord.truncated[stream] = true;
        if (accepted > 0) {
          rawChunks[stream].push(Buffer.from(bytes.subarray(0, accepted)));
          state.totalRawBytes += accepted;
        }
        if (!captureEnabled) return;
        if (accepted === 0) {
          if (final && record.lineBytes > 0 && !record.overlong) {
            collectLine(stream, record.line.subarray(0, record.lineBytes));
            record.line = Buffer.alloc(maxLineBytes);
            record.lineBytes = 0;
          }
          return;
        }
        const input = bytes.subarray(0, accepted);
        for (const byte of input) {
          if (byte === 10) {
            if (!record.overlong) {
              let withoutCr = record.line.subarray(0, record.lineBytes);
              if (withoutCr.at(-1) === 13) withoutCr = withoutCr.subarray(0, withoutCr.length - 1);
              collectLine(stream, withoutCr);
            }
            record.line = Buffer.alloc(maxLineBytes);
            record.lineBytes = 0;
            record.overlong = false;
          } else if (!record.overlong) {
            if (record.lineBytes < maxLineBytes) {
              record.line[record.lineBytes] = byte;
              record.lineBytes++;
            } else {
              record.overlong = true;
              commandRecord.truncated[stream] = true;
              record.droppedBytes += record.lineBytes + 1;
              record.line = Buffer.alloc(maxLineBytes);
              record.lineBytes = 0;
            }
          } else {
            record.droppedBytes++;
          }
        }
        if (final) {
          if (record.lineBytes > 0 && !record.overlong) {
            collectLine(stream, record.line.subarray(0, record.lineBytes));
          } else if (record.overlong) {
            record.droppedBytes += record.lineBytes;
          }
          record.line = [];
          record.lineBytes = 0;
          record.overlong = false;
        }
      }

      let child;
      try {
        child = spawn(command, args, {
          cwd: commandOptions.cwd,
          env: commandOptions.env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          ...(commandOptions.spawnOptions ?? {}),
        });
      } catch (error) {
        spawnError = error;
      }

      if (!child) {
        done = true;
        const failure = recordFailure(role === 'cleanup' ? 'cleanup' : 'primary', spawnError, 'spawn-failed');
        commandRecord.outcome = 'spawn-error';
        commandRecord.spawnError = failure;
        commandRecord.terminalElapsedMs = Math.round(elapsed());
        addEvent('command-terminal', {commandId, outcome: 'spawn-error'});
        await publish();
        const error = new ObservationError('subprocess failed to spawn', {
          code: errorCode(spawnError),
          stdout: '',
          stderr: '',
          spawnError,
          exit: undefined,
          close: undefined,
          capture: deepFreeze({...commandRecord}),
          record: deepFreeze({...commandRecord}),
          cause: spawnError,
        });
        throw error;
      }

      child.stdout.on('data', chunk => consume('stdout', chunk));
      child.stderr.on('data', chunk => consume('stderr', chunk));
      child.stdout.on('end', () => {
        if (done) return;
        consume('stdout', Buffer.alloc(0), true);
        commandRecord.eof.stdout = true;
        addEvent('stream-eof', {commandId, stream: 'stdout'});
        if (closeReceipt) settle();
      });
      child.stderr.on('end', () => {
        if (done) return;
        consume('stderr', Buffer.alloc(0), true);
        commandRecord.eof.stderr = true;
        addEvent('stream-eof', {commandId, stream: 'stderr'});
        if (closeReceipt) settle();
      });
      child.on('error', error => {
        if (done) return;
        spawnError = error;
        commandRecord.spawnError = summarizeFailure(error, 'spawn-failed');
        addEvent('spawn-error', {commandId, code: errorCode(error) ?? 'unknown'});
      });
      child.on('exit', (code, signal) => {
        if (done) return;
        exitReceipt = {code, signal};
        commandRecord.exit = exitReceipt;
        addEvent('command-exit', {commandId, code, signal});
        if (typeof commandOptions.diagnostic === 'function' && !expectedExitCodes.includes(code)
          && !timedOut && !cancelled) {
          startDiagnostic('early-exit');
        }
      });
      child.on('close', (code, signal) => {
        if (done) return;
        closeReceipt = {code, signal};
        commandRecord.close = closeReceipt;
        addEvent('command-close', {commandId, code, signal});
        if (commandRecord.eof.stdout && commandRecord.eof.stderr) settle();
      });

      const abortHandler = () => {
        cancelled = true;
        startDiagnostic('cancelled');
        terminate('cancelled');
      };
      const terminate = reason => {
        if (done || terminationStarted) return;
        terminationStarted = true;
        termSignal = 'SIGTERM';
        const availableMs = Math.max(0, commandDeadline - performance.now());
        const pipeCloseMs = Math.min(requestedPipeCloseMs, Math.floor(availableMs / 3));
        const graceMs = Math.min(requestedTerminationGraceMs, Math.max(0, availableMs - pipeCloseMs));
        commandRecord.termination.requestedElapsedMs = Math.round(elapsed());
        try {
          const sent = child.kill('SIGTERM');
          commandRecord.termination.sigtermElapsedMs = Math.round(elapsed());
          if (!sent && !exitReceipt) recordFailure('termination', {kind: 'sigterm-not-sent'}, 'termination-failed');
          addEvent('command-terminate', {commandId, reason, signal: termSignal});
        } catch (error) {
          recordFailure('termination', error, 'termination-failed');
        }
        terminationTimer = setTimeout(() => {
          if (done) return;
          try {
            const sent = child.kill('SIGKILL');
            commandRecord.termination.sigkillElapsedMs = Math.round(elapsed());
            if (!sent && !exitReceipt) {
              recordFailure('termination', {kind: 'sigkill-not-sent'}, 'termination-failed');
            }
            addEvent('command-terminate', {commandId, reason: 'termination-grace-expired', signal: 'SIGKILL'});
          } catch (error) {
            recordFailure('termination', error, 'termination-failed');
          }
          const closeWaitMs = Math.min(pipeCloseMs, Math.max(0, commandDeadline - performance.now()));
          forceTimer = setTimeout(() => {
            if (done) return;
            commandRecord.termination.pipesClosedElapsedMs = Math.round(elapsed());
            child.stdout.destroy();
            child.stderr.destroy();
            settle();
          }, closeWaitMs);
        }, graceMs);
      };
      try {
        commandOptions.onSpawn?.(child);
      } catch (error) {
        cancelled = true;
        recordFailure(role === 'cleanup' ? 'cleanup' : 'primary', error, 'spawn-observer-failed');
        terminate('spawn-observer-failed');
      }
      if (signal?.aborted) abortHandler();
      else signal?.addEventListener('abort', abortHandler, {once: true});

      const timeoutMs = Math.max(0, workDeadline - performance.now());
      let timeoutHandle;
      let diagnosticHandle;
      if (typeof commandOptions.diagnostic === 'function' && diagnosticWindow > 0) {
        diagnosticHandle = setTimeout(() => startDiagnostic('pre-deadline'), Math.max(0, timeoutMs - diagnosticWindow));
      }
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        startDiagnostic('deadline');
        terminate('timeout');
      }, timeoutMs);

      await Promise.race([
        processClosed,
      ]);
      done = true;
      clearTimeout(timeoutHandle);
      clearTimeout(diagnosticHandle);
      signal?.removeEventListener('abort', abortHandler);
      diagnosticController?.abort();
      commandRecord.terminalElapsedMs = Math.round(elapsed());
      if (diagnosticStarted && diagnosticTerminal === undefined) {
        commandRecord.diagnostic = {status: 'incomplete',
          reason: timedOut ? 'deadline-before-reply' : 'command-ended-before-reply'};
      }
      commandRecord.code = closeReceipt?.code ?? exitReceipt?.code ?? null;
      commandRecord.signal = closeReceipt?.signal ?? exitReceipt?.signal ?? null;
      commandRecord.eof.stdout = commandRecord.eof.stdout === true;
      commandRecord.eof.stderr = commandRecord.eof.stderr === true;
      commandRecord.retainedBytes.stdout = streamState.stdout.retainedBytes;
      commandRecord.retainedBytes.stderr = streamState.stderr.retainedBytes;
      commandRecord.droppedBytes.stdout = streamState.stdout.droppedBytes;
      commandRecord.droppedBytes.stderr = streamState.stderr.droppedBytes;
      commandRecord.truncated.stdout ||= streamState.stdout.overlong;
      commandRecord.truncated.stderr ||= streamState.stderr.overlong;
      const rawOverflow = commandRecord.rawDroppedBytes.stdout > 0 || commandRecord.rawDroppedBytes.stderr > 0;
      commandRecord.outcome = timedOut ? 'timeout' : cancelled ? 'cancelled'
        : spawnError ? 'spawn-error' : rawOverflow ? 'output-overflow'
          : closeReceipt ? 'exit' : 'incomplete';
      for (const stream of STREAMS) {
        if (!commandRecord.artifacts[stream]) continue;
        const streamRecord = streamState[stream];
        commandRecord.artifactMetadata[stream] = {
          sizeBytes: streamRecord.retainedBytes,
          sha256: persistedHashes[stream].copy().digest('hex'),
          sanitized: true,
          redacted: streamRecord.redactionApplied,
          truncated: commandRecord.truncated[stream] || streamRecord.droppedBytes > 0,
          partial: commandRecord.outcome !== 'exit'
            || !commandRecord.eof[stream]
            || streamRecord.droppedBytes > 0,
        };
      }

      if (timedOut || cancelled || spawnError || rawOverflow || !expectedExitCodes.includes(closeReceipt?.code)
        || !commandRecord.eof.stdout || !commandRecord.eof.stderr) {
        const category = role === 'cleanup' ? 'cleanup' : role === 'diagnostic' ? 'diagnostic' : 'primary';
        const failureError = spawnError ?? new ObservationError(
          rawOverflow ? 'subprocess output exceeded its capture limit' : 'subprocess did not complete successfully',
          {
            kind: commandRecord.outcome,
            ...(rawOverflow ? {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'} : {}),
          },
        );
        const failure = recordFailure(category, failureError, commandRecord.outcome);
        if (role === 'primary' && state.primaryFailure === undefined) state.primaryFailure = deepFreeze({...failure});
      }

      if (diagnosticPromise && !done) await diagnosticPromise;
      addEvent('command-terminal', {
        commandId,
        outcome: commandRecord.outcome,
        code: commandRecord.code,
        eof: {...commandRecord.eof},
      });
      await publish();

      const capture = deepFreeze({
        ...commandRecord,
        exit: exitReceipt ? {...exitReceipt} : undefined,
        close: closeReceipt ? {...closeReceipt} : undefined,
        spawnError: commandRecord.spawnError,
        diagnostic: diagnosticTerminal ?? commandRecord.diagnostic,
      });
      const rawOutput = stream => Buffer.concat(rawChunks[stream]);
      const outputValue = stream => encoding === 'buffer' || encoding === null
        ? rawOutput(stream)
        : rawOutput(stream).toString(encoding);
      const stdout = outputValue('stdout');
      const stderr = outputValue('stderr');
      if (commandRecord.outcome === 'exit' && expectedExitCodes.includes(commandRecord.code)
        && commandRecord.eof.stdout && commandRecord.eof.stderr && !rawOverflow) {
        return deepFreeze({
          stdout,
          stderr,
          code: commandRecord.code,
          signal: commandRecord.signal,
          record: capture,
          capture,
        });
      }
      throw new ObservationError('subprocess did not complete successfully', {
        code: rawOverflow ? 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' : errorCode(spawnError) ?? commandRecord.code,
        signal: commandRecord.signal,
        stdout,
        stderr,
        spawnError,
        exit: exitReceipt ? deepFreeze({...exitReceipt}) : undefined,
        close: closeReceipt ? deepFreeze({...closeReceipt}) : undefined,
        record: capture,
        capture,
        timedOut,
        cancelled,
      });
    },
    finalize: async ({
      cleanup,
      diagnostics,
      cleanupErrors = [],
      publicationErrors = [],
      cleanupVerified,
    } = {}) => {
      if (state.terminal) return state.terminal;
      if (cleanup && cleanup.ok !== true) recordFailure('cleanup', cleanup.error ?? cleanup, 'cleanup-incomplete');
      if (diagnostics && diagnostics.required === true && diagnostics.complete !== true) {
        recordFailure('diagnostic', diagnostics.error ?? {kind: 'diagnostic-incomplete'}, 'diagnostic-incomplete');
      }
      for (const error of cleanupErrors) recordFailure('cleanup', error, 'cleanup-failed');
      for (const error of publicationErrors) recordFailure('publication', error, 'publication-failed');
      if (cleanupVerified === false) recordFailure('cleanup', {kind: 'cleanup-unverified'}, 'cleanup-unverified');
      if (performance.now() >= wholeDeadline)
        recordFailure('publication', {kind: 'whole-deadline-expired'}, 'whole-deadline-expired');
      state.finalized = true;
      state.phaseName = 'finalized';
      addEvent('run-terminal', {ok: isSuccessful()});
      let saved = await publish();
      if (performance.now() >= wholeDeadline &&
          !state.failures.publication.some(failure => failure.kind === 'whole-deadline-expired')) {
        recordFailure('publication', {kind: 'whole-deadline-expired'}, 'whole-deadline-expired');
        saved = await publish() && saved;
      }
      if (!saved) state.finalized = true;
      state.terminal = deepFreeze({
        schemaVersion: SCHEMA_VERSION,
        runId,
        scenario: state.scenario,
        ...(state.endpoint ? {endpoint: state.endpoint} : {}),
        outputDir,
        ok: isSuccessful() && saved,
        elapsedMs: Math.round(elapsed()),
        primary: state.primary,
        firstFailure: state.primaryFailure,
        failures: structuredClone(state.failures),
        commands: structuredClone(state.commands),
        manifestPath: path.join(outputDir, 'manifest.json'),
        publicationComplete: saved,
      });
      return state.terminal;
    },
  };

  const initialSaved = await publish();
  if (!initialSaved) throw new ObservationError('could not publish initial incomplete manifest', {
    kind: 'publication-failed',
    outputDir,
  });
  return Object.freeze(context);
}

async function chmodPrivate(directory) {
  if (process.platform === 'win32') return;
  const {chmod} = await import('node:fs/promises');
  await chmod(directory, 0o700);
}

function safeDiagnosticValue(value) {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return {recorded: true, suppressed: true};
  if (typeof value === 'object' && typeof value.artifact === 'string' &&
      /^snapshot-command-\d+\.json$/.test(value.artifact) &&
      Number.isSafeInteger(value.bytes) && value.bytes >= 0 &&
      typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)) {
    return {artifact: value.artifact, bytes: value.bytes, sha256: value.sha256};
  }
  if (typeof value === 'object' && value.available === false &&
      typeof value.reason === 'string' && /^[a-z-]{1,80}$/.test(value.reason)) {
    return {available: false, reason: value.reason};
  }
  return {recorded: true};
}
