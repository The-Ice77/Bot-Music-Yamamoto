import { clearCommand } from './clear.js';
import { configCommand } from './config.js';
import { loopCommand } from './loop.js';
import { nowPlayingCommand } from './nowplaying.js';
import { pauseCommand } from './pause.js';
import { playCommand } from './play.js';
import { queueCommand } from './queue.js';
import { removeCommand } from './remove.js';
import { resumeCommand } from './resume.js';
import { shuffleCommand } from './shuffle.js';
import { skipCommand } from './skip.js';
import { stopCommand } from './stop.js';
import type { SlashCommand } from './types.js';
import { volumeCommand } from './volume.js';

export const allCommands: readonly SlashCommand[] = [
  playCommand,
  pauseCommand,
  resumeCommand,
  skipCommand,
  stopCommand,
  queueCommand,
  nowPlayingCommand,
  shuffleCommand,
  loopCommand,
  volumeCommand,
  removeCommand,
  clearCommand,
  configCommand,
];

export const commandsByName: ReadonlyMap<string, SlashCommand> = new Map(
  allCommands.map((command) => [command.data.name, command]),
);

export {
  playCommand,
  pauseCommand,
  resumeCommand,
  skipCommand,
  stopCommand,
  queueCommand,
  nowPlayingCommand,
  shuffleCommand,
  loopCommand,
  volumeCommand,
  removeCommand,
  clearCommand,
  configCommand,
};
export * from './types.js';
export * from './guards.js';
