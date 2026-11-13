#!/usr/bin/env node
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { realpathSync } from 'fs';
import { forward } from './forward-child.js';

// realpathSync resolves an npm bin symlink to this file. The code then finds dist/ next to the real cli/.
forward(join(dirname(realpathSync(fileURLToPath(import.meta.url))), '../dist/search-cli.js'));
