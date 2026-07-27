/**
 * Standalone desktop entry point.
 *
 * Everything of substance lives in `app.ts`, which has no import side effects.
 * This file exists only to start the standalone application — and it declines
 * to do so when a host has embedded the module, so the same build serves both:
 * run it directly and you get the desktop app, `require()` it from another
 * Electron main process and you get the API with nothing started behind your
 * back.
 */
import { startStandalone } from './app'

export {
  registerEventHorizonHandlers,
  openEventHorizonWindow,
  eventHorizonStatus,
  setHostContext,
  getHostContext,
  startStandalone,
  type OpenWindowOptions,
  type EventHorizonStatus
} from './app'

if (!process.env.EVENT_HORIZON_EMBEDDED) {
  void startStandalone()
}
