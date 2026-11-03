// Service worker entry. Service modules register their message handlers and
// chrome.* listeners synchronously at import time (MV3 requires top-level registration).

import { installRouter } from './router.js';
import './vault-service.js';
import './clipboard.js';
import './autofill-service.js';
import './passkey-service.js';

installRouter();
