import fs from 'node:fs/promises';
import net from 'node:net';

export const DEFAULT_CHROME_EXECUTABLE_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
export const CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE = 'BILIBILI_E2E_CHROME';

export async function findAvailablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('temporary port listener has no numeric address');
  }
  const port = address.port;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
  return port;
}

// 浏览器脚本默认无窗口运行（完整 Chrome，--headless，不是 chrome-headless-shell）；
// 命令行传 --headed 才开一个可见窗口。开关只由命令行控制，不读任何环境变量。
export function parseHeadedFlag(argv = process.argv.slice(2)) {
  for (const value of argv) {
    if (value !== '--headed') throw new Error(`unknown argument ${value}; only --headed is allowed`);
  }
  return argv.includes('--headed');
}

export async function resolveChromeExecutablePath({
  environment = process.env,
  stat = fs.stat,
} = {}) {
  const candidate = environment[CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE] === undefined
    ? DEFAULT_CHROME_EXECUTABLE_PATH
    : environment[CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE];
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('path is not a file');
  } catch (error) {
    const source = environment[CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE] === undefined
      ? `the default path ${DEFAULT_CHROME_EXECUTABLE_PATH}`
      : `${CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE}=${candidate}`;
    throw new Error(
      `Chrome executable is unavailable at ${candidate}; ${source} is missing or not a regular file. `
      + `Set ${CHROME_EXECUTABLE_ENVIRONMENT_VARIABLE} to the system Chrome executable. `
      + `Playwright bundled Chromium is not used.`,
      { cause: error },
    );
  }
  return candidate;
}
