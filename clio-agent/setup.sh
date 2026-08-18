#!/bin/bash
set -e
echo "Setting up CLIO..."
npm install
pip3 install -r requirements.txt
mkdir -p uploads reports db
node -e "
const Database = require('better-sqlite3');
const fs = require('fs');
const db = new Database('./db/clio.db');
const schema = fs.readFileSync('./db/schema.sql', 'utf8');
db.exec(schema);
console.log('Database initialized.');
"
cp -n .env.example .env || true
echo "Done. Edit .env then run: node server.js"
