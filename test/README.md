# Tests

Run from the plugin root:

```sh
node test/route-registration.test.mjs
```

`lib/index.js` imports `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-credentials` and
`@deepseek-ai/schemastery`, which the DSH host normally supplies at load time. To run
the suite standalone, link them in first — they live inside an installed DSH:

```sh
mkdir -p node_modules/@deepseek-ai
G=/path/to/dsh/node_modules/@deepseek-ai
P=~/.dsh/profiles/desktop/node_modules/@deepseek-ai
for pkg in dsh-tools dsh-credentials dsh-launch-environment; do
  ln -sfn "$G/$pkg" "node_modules/@deepseek-ai/$pkg"
done
ln -sfn "$P/schemastery" node_modules/@deepseek-ai/schemastery
```

`node_modules/` is gitignored, so these links never ship.
