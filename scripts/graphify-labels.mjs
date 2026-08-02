/**
 * Modul: graphify-Community-Namen
 * Zweck: Wendet die handvergebenen Community-Namen aus scripts/graphify-labels.json
 *        auf graphify-out/graph.json an.
 * Ausführen: node scripts/graphify-labels.mjs
 *
 * Warum verankert statt gemappt: graphify vergibt Community-IDs bei jedem
 * Re-Clustering neu. Namen über die ID zu übertragen verliert sie beim nächsten
 * `graphify update` - genau das ist einmal passiert und hat gut hundert Namen
 * gekostet. Jeder Name hängt deshalb an einem Knoten (`anchors`) oder an der
 * Datei, die eine Community dominiert (`fileAnchors`). Beides überlebt das
 * Neuschneiden der Communities.
 *
 * Ins Leere zeigende Anker werden gemeldet, nicht verschwiegen: verschwindet ein
 * verankertes Symbol, fällt das hier auf statt still einen Namen zu verlieren.
 *
 * Danach `graphify export html`, damit die Ansicht die Namen übernimmt.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = path.join(ROOT, 'scripts', 'graphify-labels.json');
const OUT = path.join(ROOT, 'graphify-out');
const GRAPH = path.join(OUT, 'graph.json');

if (!existsSync(GRAPH)) {
  console.error(`graph.json fehlt unter ${GRAPH} - erst \`graphify update .\` laufen lassen.`);
  process.exit(1);
}

const manual = JSON.parse(readFileSync(LABELS, 'utf8'));
const anchors = manual.anchors ?? {};
const fileAnchors = manual.fileAnchors ?? {};
const graph = JSON.parse(readFileSync(GRAPH, 'utf8'));

const communityOf = new Map();
const members = new Map();
for (const node of graph.nodes) {
  const c = node.community;
  if (c === undefined || c === null) continue;
  communityOf.set(node.id, c);
  if (!members.has(c)) members.set(c, []);
  members.get(c).push(node);
}

// Erster Treffer gewinnt: fallen zwei Anker in dieselbe Community, bleibt der
// zuerst deklarierte Name stehen (die Reihenfolge in der JSON ist die Absicht).
const newName = new Map();
const missing = [];
let hits = 0;

for (const [nodeId, label] of Object.entries(anchors)) {
  const c = communityOf.get(nodeId);
  if (c === undefined) {
    missing.push(nodeId);
    continue;
  }
  if (!newName.has(c)) newName.set(c, label);
  hits++;
}

for (const [relPath, label] of Object.entries(fileAnchors)) {
  let best = null;
  let bestCount = 0;
  for (const [c, nodes] of members) {
    const k = nodes.filter((n) => (n.source_file ?? '').endsWith(relPath)).length;
    if (k > bestCount) {
      best = c;
      bestCount = k;
    }
  }
  if (best === null) {
    missing.push(relPath);
    continue;
  }
  if (!newName.has(best)) newName.set(best, label);
  hits++;
}

let changed = 0;
for (const node of graph.nodes) {
  const label = newName.get(node.community);
  if (label && node.community_name !== label) {
    node.community_name = label;
    changed++;
  }
}
writeFileSync(GRAPH, JSON.stringify(graph), 'utf8');

const labelsCache = path.join(OUT, '.graphify_labels.json');
if (existsSync(labelsCache)) {
  const cache = JSON.parse(readFileSync(labelsCache, 'utf8'));
  // ERST DIE EIGENEN ALT-EINTRÄGE RÄUMEN, dann schreiben. Ein reines Merge ließ
  // die Community-ID eines früheren Laufs samt Namen stehen; da die IDs beim
  // Re-Clustering neu vergeben werden, hängt der Name beim nächsten
  // `graphify update` an irgendeiner fremden Community, die dieselbe ID
  // wiederbekommt - genau die ID-Instabilität, gegen die die Anker antreten.
  //
  // Erkannt am NAMEN, nicht an der ID: nur so bleibt unberührt, was graphify
  // selbst in den Cache geschrieben hat.
  const ownLabels = new Set([...Object.values(anchors), ...Object.values(fileAnchors)]);
  for (const [c, label] of Object.entries(cache)) {
    if (ownLabels.has(label)) delete cache[c];
  }
  for (const [c, label] of newName) cache[String(c)] = label;
  writeFileSync(labelsCache, JSON.stringify(cache), 'utf8');
}

console.log(`${hits} Anker getroffen, ${newName.size} Communities benannt, ${changed} Knoten aktualisiert`);
if (missing.length) {
  console.log(`${missing.length} Anker nicht gefunden (Symbol oder Datei existiert nicht mehr):`);
  for (const m of missing) console.log(`   ${m}`);
}
