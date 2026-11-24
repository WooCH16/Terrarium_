import { createStore, addMemo, listMemos } from './src/memo.mjs';

const store = createStore(process.env.MEMO_FILE || './memos.json');
const [command, ...args] = process.argv.slice(2);

if (command === 'add') {
  const memo = addMemo(store, args[0], args[1] ?? '');
  console.log(`added ${memo.id}`);
} else if (command === 'list') {
  for (const m of listMemos(store)) console.log(`${m.id}\t${m.title}\t${m.createdAt}`);
} else {
  console.error('usage: node cli.mjs add <title> <body> | list');
  process.exit(1);
}
