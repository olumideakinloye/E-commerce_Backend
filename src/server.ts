import { env } from '@config/env.js';
import { APP_NAME, API_VERSION } from '@config/constants.js';

console.log(`${APP_NAME} (${API_VERSION}) running in ${env.NODE_ENV} mode on port ${env.PORT}.`);
