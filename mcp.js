require('dotenv').config();
const fs = require('fs');
const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const PARENT_PAGE_ID = process.env.NOTION_PAGE_ID;
const STATE_FILE = '.notion-state.json';
const tasks = require('./tasks.json');

// Usage: node import-to-notion.js            -> import everything
//        node import-to-notion.js --limit=3  -> test with the first 3 tasks only
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : tasks.length;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Notion allows ~3 requests/second, so wait between calls and retry on 429
async function call(fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fn();
      await sleep(350);
      return res;
    } catch (e) {
      if (e.status === 429 || e.code === 'rate_limited') {
        await sleep(2000 * attempt);
        continue;
      }
      throw e;
    }
  }
  throw new Error('Too many retries');
}

// State file lets you re-run the script without creating duplicates
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return { dbId: null, pages: {}, relationsDone: false };
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function createDatabase() {
  const db = await call(() =>
    notion.databases.create({
      parent: { type: 'page_id', page_id: PARENT_PAGE_ID },
      title: [{ type: 'text', text: { content: 'E-commerce Microservices - Tasks' } }],
      properties: {
        Task: { title: {} },
        Phase: { select: {} },
        Skill: { multi_select: {} },
        'Estimate (days)': { number: {} },
        Priority: {
          select: {
            options: [
              { name: 'High', color: 'red' },
              { name: 'Medium', color: 'yellow' },
              { name: 'Low', color: 'gray' },
            ],
          },
        },
        Status: {
          select: {
            options: [
              { name: 'Not started', color: 'default' },
              { name: 'In progress', color: 'blue' },
              { name: 'Done', color: 'green' },
            ],
          },
        },
        Timeline: { date: {} },
        Owner: { rich_text: {} },
      },
    })
  );
  return db.id;
}

async function addTask(dbId, t) {
  const page = await call(() =>
    notion.pages.create({
      parent: { database_id: dbId },
      properties: {
        Task: { title: [{ text: { content: t.task } }] },
        Phase: { select: { name: t.phase } },
        Skill: { multi_select: t.skills.map((name) => ({ name })) },
        'Estimate (days)': { number: t.days },
        Priority: { select: { name: t.priority } },
        Status: { select: { name: 'Not started' } },
        Timeline: { date: { start: t.start, end: t.deadline } },
        Owner: { rich_text: [{ text: { content: t.owner || '' } }] },
      },
    })
  );
  return page.id;
}

// Adds a self-relation column "Depends on" and fills it from tasks.json
async function addDependencies(state) {
  await call(() =>
    notion.databases.update({
      database_id: state.dbId,
      properties: {
        'Depends on': {
          relation: { database_id: state.dbId, single_property: {} },
        },
      },
    })
  );

  for (const t of tasks.slice(0, LIMIT)) {
    const ids = (t.dependsOn || []).map((name) => state.pages[name]).filter(Boolean);
    if (ids.length === 0) continue;
    await call(() =>
      notion.pages.update({
        page_id: state.pages[t.task],
        properties: {
          'Depends on': { relation: ids.map((id) => ({ id })) },
        },
      })
    );
    console.log(`Linked: ${t.task} -> ${ids.length} dependency(ies)`);
  }
}

async function main() {
  if (!process.env.NOTION_TOKEN || !PARENT_PAGE_ID) {
    console.error('Missing NOTION_TOKEN or NOTION_PAGE_ID in .env');
    process.exit(1);
  }

  const state = loadState();

  if (!state.dbId) {
    state.dbId = await createDatabase();
    saveState(state);
    console.log('Database created:', state.dbId);
  }

  const batch = tasks.slice(0, LIMIT);
  for (const [i, t] of batch.entries()) {
    if (state.pages[t.task]) continue; // already created in a previous run
    state.pages[t.task] = await addTask(state.dbId, t);
    saveState(state);
    console.log(`[${i + 1}/${batch.length}] Created: ${t.task}`);
  }

  if (!state.relationsDone && Object.keys(state.pages).length === tasks.length) {
    await addDependencies(state);
    state.relationsDone = true;
    saveState(state);
  } else if (!state.relationsDone) {
    console.log('Test run done. Re-run without --limit to import the rest and link dependencies.');
    return;
  }

  console.log('Done. Open the database in Notion and add a Timeline view on the "Timeline" property.');
}

main().catch((e) => {
  console.error('Error:', e.code || '', e.message);
  if (e.code === 'object_not_found') {
    console.error('Share the parent page with your integration: ... > Connections > your integration.');
  }
  process.exit(1);
});