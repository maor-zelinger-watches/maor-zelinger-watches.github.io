/**
 * api-client.js — The app's single API client instance.
 *
 * api.js exports the pure factory (unit-testable against any base URL);
 * this module binds it to the deployed backend so every feature module
 * shares one client instead of each constructing its own.
 */

import { createApiClient } from './api.js';
import { CONFIG } from './config.js';

export const api = createApiClient(CONFIG.APPS_SCRIPT_URL, {
  retryDelaysMs: CONFIG.API_RETRY_DELAYS_MS,
});
