const { resolve } = require("path");
const kuromoji = require("kuromoji");

module.exports = function buildTokenizer() {
  return new Promise((resolvePromise, reject) => {
    kuromoji.builder({
      dicPath: resolve(__dirname, "../node_modules/kuromoji/dict"),
    }).build((err, tokenizer) => {
      if (err) reject(err);
      else resolvePromise(tokenizer);
    });
  });
};
