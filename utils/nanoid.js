const crypto = require('crypto');
const urlAlphabet = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function nanoid(size = 21) {
  const bytes = crypto.randomBytes(size);
  let id = '';
  for (let i = 0; i < size; i++) {
    id += urlAlphabet[bytes[i] & 63];
  }
  return id;
}

module.exports = { nanoid };
