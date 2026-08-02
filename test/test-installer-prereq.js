import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  commandAvailable, checkPrereqs, spawnStart, createInstallerServer,
  detectEngine, composeCommand, inspectCommand,
} from '../tools/installer/install-server.js';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

// ── commandAvailable ──────────────────────────────────────────────────────────

test('commandAvailable meldet false für ein nicht existierendes Kommando', async () => {
  assert.equal(await commandAvailable('definitely-not-a-real-binary-xyz', ['--version']), false);
});

test('commandAvailable meldet true für ein vorhandenes Kommando (node)', async () => {
  assert.equal(await commandAvailable('node', ['--version']), true);
});

// ── checkPrereqs (injizierbarer Probe-Callback, deterministisch) ───────────────

test('checkPrereqs meldet fehlendes docker als ok:false mit missing-Liste', async () => {
  const r = await checkPrereqs(async () => false);
  assert.equal(r.ok, false);
  assert.ok(Array.isArray(r.missing));
  assert.ok(r.missing.includes('docker'), 'missing enthält "docker" nicht');
});

test('checkPrereqs meldet ok:true mit leerer missing-Liste, wenn alles vorhanden ist', async () => {
  const r = await checkPrereqs(async () => true);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
});

// ── spawnStart (Spawn-Fehler an Aufrufer melden) ───────────────────────────────

test('spawnStart meldet ok:false bei Spawn-Fehler (unbekanntes Kommando)', async () => {
  const r = await spawnStart('definitely-not-a-real-binary-xyz', []);
  assert.equal(r.ok, false);
  assert.ok(r.error, 'Spawn-Fehler liefert keine error-Meldung');
});

test('spawnStart meldet ok:true, wenn der Prozess erfolgreich startet', async () => {
  const r = await spawnStart('node', ['-e', '']);
  assert.equal(r.ok, true);
});

// ── detectEngine (Docker bevorzugt, Podman-Fallback) ───────────────────────────

// Baut einen injizierbaren check(cmd, args), der nur für die in `present`
// gelisteten "cmd args"-Kombinationen true liefert.
function checkFor(present) {
  const set = new Set(present);
  return async (cmd, args = []) => set.has([cmd, ...args].join(' '));
}

test('detectEngine wählt docker, wenn docker + compose v2 vorhanden sind', async () => {
  const e = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.equal(e.engine, 'docker');
  assert.equal(e.composeBin, 'docker');
  assert.deepEqual(e.compose, ['compose']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine fällt auf "podman compose" zurück, wenn docker fehlt', async () => {
  const e = await detectEngine(checkFor(['podman --version', 'podman compose version']));
  assert.equal(e.engine, 'podman');
  assert.equal(e.composeBin, 'podman');
  assert.deepEqual(e.compose, ['compose', '-f', 'podman-compose.yml']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine nutzt podman-compose, wenn "podman compose" fehlt', async () => {
  const e = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.equal(e.engine, 'podman');
  assert.equal(e.composeBin, 'podman-compose');
  assert.deepEqual(e.compose, ['-f', 'podman-compose.yml']);
  assert.deepEqual(e.missing, []);
});

test('detectEngine meldet engine:null, wenn weder docker noch podman da sind', async () => {
  const e = await detectEngine(async () => false);
  assert.equal(e.engine, null);
  assert.ok(e.missing.includes('docker'));
  assert.ok(e.missing.includes('podman'));
});

test('detectEngine meldet fehlendes compose, wenn nur podman (ohne compose) da ist', async () => {
  const e = await detectEngine(checkFor(['podman --version']));
  assert.equal(e.engine, null);
  assert.ok(e.missing.some(m => /compose/.test(m)), 'missing nennt kein fehlendes compose');
});

// ── composeCommand / inspectCommand (Engine-aware Spawn-Argumente) ──────────────

test('composeCommand baut den richtigen Befehl je Engine', async () => {
  const docker = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.deepEqual(composeCommand(docker, ['up', '-d']),
    { cmd: 'docker', args: ['compose', 'up', '-d'] });

  const podman = await detectEngine(checkFor(['podman --version', 'podman compose version']));
  assert.deepEqual(composeCommand(podman, ['up', '-d']),
    { cmd: 'podman', args: ['compose', '-f', 'podman-compose.yml', 'up', '-d'] });

  const pc = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.deepEqual(composeCommand(pc, ['logs', '--tail', '30']),
    { cmd: 'podman-compose', args: ['-f', 'podman-compose.yml', 'logs', '--tail', '30'] });
});

test('inspectCommand nutzt das passende Binary (podman auch bei podman-compose)', async () => {
  const pc = await detectEngine(checkFor(['podman --version', 'podman-compose --version']));
  assert.deepEqual(inspectCommand(pc, ['inspect', 'yuvomi']),
    { cmd: 'podman', args: ['inspect', 'yuvomi'] });

  const docker = await detectEngine(checkFor(['docker --version', 'docker compose version']));
  assert.deepEqual(inspectCommand(docker, ['inspect', 'yuvomi']),
    { cmd: 'docker', args: ['inspect', 'yuvomi'] });
});

// ── checkPrereqs liefert den Engine-Deskriptor mit ─────────────────────────────

test('checkPrereqs gibt engine-Deskriptor zurück (podman-Fallback)', async () => {
  const r = await checkPrereqs(checkFor(['podman --version', 'podman compose version']));
  assert.equal(r.ok, true);
  assert.equal(r.engine.engine, 'podman');
});

// ── Statische Artefakte: podman-compose.yml, Quadlet, install.sh ────────────────

test('podman-compose.yml trägt :Z-Labels, OIKOS_HTTP_BIND und SESSION_SECURE-Default', () => {
  const src = readFileSync(new URL('../podman-compose.yml', import.meta.url), 'utf8');
  assert.match(src, /\/data:Z/, 'kein :Z-Label auf dem /data-Mount');
  assert.match(src, /\$\{OIKOS_HTTP_BIND:-0\.0\.0\.0\}/, 'kein konfigurierbares Host-Binding');
  assert.match(src, /SESSION_SECURE=\$\{SESSION_SECURE:-false\}/, 'kein SESSION_SECURE-Default');
});

test('Quadlet-Unit existiert mit :Z-Volume und EnvironmentFile', () => {
  const src = readFileSync(new URL('../tools/quadlet/oikos.container', import.meta.url), 'utf8');
  assert.match(src, /\[Container\]/, 'keine [Container]-Sektion');
  assert.match(src, /EnvironmentFile=/, 'kein EnvironmentFile');
  assert.match(src, /:Z\b/, 'kein :Z-SELinux-Label');
  assert.match(src, /WantedBy=default\.target/, 'kein [Install]-Autostart-Target');
});

test('install.sh enthält den Podman-Fallback', () => {
  const src = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
  assert.match(src, /podman compose/, 'install.sh kennt "podman compose" nicht');
  assert.match(src, /podman-compose/, 'install.sh kennt "podman-compose" nicht');
});

// ── HTTP-Route /api/prereqs ────────────────────────────────────────────────────

async function withServer(fn) {
  const prev = process.env.OIKOS_INSTALLER_ROOT;
  process.env.OIKOS_INSTALLER_ROOT = REPO_ROOT;
  const server = createInstallerServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(r => server.close(r));
    if (prev === undefined) delete process.env.OIKOS_INSTALLER_ROOT;
    else process.env.OIKOS_INSTALLER_ROOT = prev;
  }
}

test('GET /api/prereqs liefert 200 mit ok-Flag und missing-Array', async () => {
  await withServer(async base => {
    const r = await fetch(`${base}/api/prereqs`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(typeof d.ok, 'boolean');
    assert.ok(Array.isArray(d.missing), 'missing ist kein Array');
  });
});

// ── Statische Prüfungen: UI verdrahtet Prereq-Check und Start-Fehler ───────────

test('install.html ruft /api/prereqs auf und behandelt Start-Fehler', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /\/api\/prereqs/, 'install.html ruft /api/prereqs nicht auf');
  assert.match(src, /id="cfg-prereq"/, 'install.html hat kein Prereq-Banner cfg-prereq');
});

test('install.html enthält den Erweitert-Step mit Reverse-Proxy-, OIDC- und Backup-Feldern', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /id="step-advanced"/, 'kein Erweitert-Step (step-advanced)');
  assert.match(src, /id="adv-proxy"/, 'keine Reverse-Proxy-Auswahl (adv-proxy)');
  assert.match(src, /id="oidc-issuer"/, 'kein OIDC-Issuer-Feld');
  assert.match(src, /id="adv-backup-enable"/, 'kein Backup-Aktivieren-Feld');
});

// ── Reverse-Proxy: SESSION_SECURE wirkt zur Laufzeit ───────────────────────────

test('docker-compose.yml leitet SESSION_SECURE aus der .env ab (Default false)', () => {
  const src = readFileSync(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(src, /SESSION_SECURE=\$\{SESSION_SECURE:-false\}/,
    'compose nutzt nicht ${SESSION_SECURE:-false} (env_file darf nicht hart überstimmt werden)');
  assert.doesNotMatch(src, /^\s*-\s*SESSION_SECURE=false\s*$/m,
    'hartkodiertes SESSION_SECURE=false darf nicht mehr im environment-Block stehen');
});

test('install.html setzt im Reverse-Proxy-Pfad SESSION_SECURE=true', () => {
  const src = readFileSync(new URL('../tools/installer/install.html', import.meta.url), 'utf8');
  assert.match(src, /S\.SESSION_SECURE\s*=\s*'true'/,
    'Proxy-Pfad schreibt SESSION_SECURE nicht auf true');
});

// ── env-schema deckt die neuen Settings ab ─────────────────────────────────────

test('env-schema enthält die neuen P5-Settings als writeToEnv', async () => {
  const { ENV_SCHEMA } = await import('../tools/installer/env-schema.js');
  const writable = new Set(ENV_SCHEMA.filter(e => e.writeToEnv).map(e => e.key));
  for (const key of [
    'SESSION_SECURE', 'TRUST_PROXY', 'APPLE_CALDAV_URL',
    'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URI',
    'BACKUP_ENABLED', 'BACKUP_SCHEDULE', 'BACKUP_KEEP',
  ]) {
    assert.ok(writable.has(key), `env-schema fehlt writeToEnv-Key ${key}`);
  }
});
