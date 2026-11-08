// One-time setup: creates .env, installs packages and restores .NET dependencies.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';

const run = (command) => execSync(command, { stdio: 'inherit' });

if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  console.log('Created .env from .env.example');
}
run('npm install');
run('npm --prefix frontend install');
run('dotnet restore backend');

const hasKey = /^GEMINI_API_KEY=.+$/m.test(readFileSync('.env', 'utf8'));
console.log(hasKey
  ? '\nReady. Run: npm run dev'
  : '\nNearly ready. Add GEMINI_API_KEY to .env (https://aistudio.google.com/apikey), then run: npm run dev');
