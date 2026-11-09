import { spawn } from 'node:child_process';
import readline from 'node:readline';

/**
 * Parses one line of `azcopy --output-type json`: {TimeStamp, MessageType, MessageContent, PromptDetails}.
 * For Init / Progress / EndOfJob, MessageContent is itself a JSON document inside a string; it is
 * returned decoded as `data`. Anything that is not an azcopy message comes back as type "Raw".
 */
export function parseAzcopyLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { type: 'Raw', text: line };
  }
  if (typeof msg?.MessageType !== 'string') return { type: 'Raw', text: line };

  const text = typeof msg.MessageContent === 'string' ? msg.MessageContent : JSON.stringify(msg.MessageContent);
  let data;
  if (text.trimStart().startsWith('{')) {
    try {
      data = JSON.parse(text);
    } catch {
      /* a plain text message that merely starts with "{" */
    }
  }
  return { type: msg.MessageType, text, data, prompt: msg.PromptDetails };
}

/**
 * Starts azcopy and calls onMessage for every parsed stdout line. `command` is {bin, prefixArgs}.
 * stdin is closed (not inherited) so azcopy can never block waiting for an answer to a prompt.
 * `done` resolves with {code, signal} or {error} (e.g. azcopy not found); it never rejects.
 */
export function startAzcopy({ command, args, env, onMessage, onStderr }) {
  const child = spawn(command.bin, [...(command.prefixArgs ?? []), ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = (stream, handler) => readline.createInterface({ input: stream }).on('line', (l) => l.trim() && handler?.(l));
  lines(child.stdout, (l) => onMessage?.(parseAzcopyLine(l)));
  lines(child.stderr, onStderr);
  const done = new Promise((resolve) => {
    child.on('error', (error) => resolve({ error }));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  return { child, done };
}

/** Runs a short azcopy command to completion and returns its parsed messages. */
export async function captureAzcopy({ command, args, env }) {
  const messages = [];
  const { done } = startAzcopy({ command, args, env, onMessage: (m) => messages.push(m) });
  return { ...(await done), messages };
}
