# chiasmus-adapter-swift

Swift language adapter for [chiasmus](https://github.com/yogthos/chiasmus#), built on `tree-sitter-swift`.

This package parses Swift source and emits a CodeGraph with:

- `defines`
- `calls`
- `imports`
- `exports`
- `contains`

## Requirements

- Node.js `>=20`

## Install

```bash
npm install chiasmus-adapter-swift
```

Peer dependency:

- `tree-sitter` (`^0.22`)

## Usage

```ts
import Parser from "tree-sitter";
import Swift from "tree-sitter-swift";
import adapter from "chiasmus-adapter-swift";

const parser = new Parser();
parser.setLanguage(Swift);

const source = `
import Foundation

func greet() {
  print("hello")
}
`;

const tree = parser.parse(source);
const graph = adapter.extract(tree.rootNode, "example.swift");

console.log(graph.defines);
console.log(graph.calls);
```

## Development

```bash
npm install
npm run build
npm test
```

Additional scripts:

- `npm run test:watch`
- `npm run typecheck`
