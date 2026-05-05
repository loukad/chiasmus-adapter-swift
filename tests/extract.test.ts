import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Parser from "tree-sitter";
// @ts-expect-error - no types shipped
import Swift from "tree-sitter-swift";
import adapter, { extractSwift } from "../src/index.js";

const FIXTURE = join(__dirname, "fixtures", "sample.swift");

let parser: Parser;
beforeAll(() => {
  parser = new Parser();
  parser.setLanguage(Swift);
});

function parseFile(path: string) {
  const src = readFileSync(path, "utf8");
  const tree = parser.parse(src);
  return { src, tree };
}

describe("adapter shape", () => {
  it("declares language, extensions, grammar", () => {
    expect(adapter.language).toBe("swift");
    expect(adapter.extensions).toContain(".swift");
    expect(adapter.grammar).toMatchObject({ package: "tree-sitter-swift" });
    expect(typeof adapter.extract).toBe("function");
  });
});

describe("extractSwift on fixture", () => {
  it("extracts imports", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const sources = g.imports.map((i) => i.source).sort();
    expect(sources).toEqual(["Foundation", "UIKit.UIView"]);
    // Dotted import: name is the leaf segment, source is the full path
    const uiKit = g.imports.find((i) => i.source === "UIKit.UIView");
    expect(uiKit?.name).toBe("UIView");
  });

  it("extracts type defines (class, struct, enum, protocol) but not extension", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const types = g.defines.filter((d) => d.kind === "class" || d.kind === "interface");
    const names = types.map((d) => d.name).sort();
    // Person (struct), Robot (class), Color (enum) → kind: "class"
    // Greeter → kind: "interface"
    expect(names).toEqual(["Color", "Greeter", "Person", "Robot"]);
    expect(types.find((d) => d.name === "Greeter")?.kind).toBe("interface");
    // Extension on Person must NOT add a duplicate Person define.
    expect(types.filter((d) => d.name === "Person")).toHaveLength(1);
  });

  it("extracts methods with containment edges to their parent type", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const methods = g.defines.filter((d) => d.kind === "method").map((d) => d.name);
    // Person: greet, shout, wave (extension)
    // Robot: init, boot, beep, staticHello
    // Greeter: greet (protocol method)
    expect(methods).toEqual(
      expect.arrayContaining(["greet", "shout", "wave", "init", "boot", "beep", "staticHello"]),
    );

    const personChildren = g.contains
      .filter((c) => c.parent === "Person")
      .map((c) => c.child)
      .sort();
    expect(personChildren).toEqual(["greet", "shout", "wave"]);

    const robotChildren = g.contains
      .filter((c) => c.parent === "Robot")
      .map((c) => c.child)
      .sort();
    expect(robotChildren).toEqual(["beep", "boot", "init", "staticHello"]);

    expect(g.contains).toContainEqual({ parent: "Greeter", child: "greet" });
  });

  it("extracts free function defines", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const free = g.defines.filter((d) => d.kind === "function").map((d) => d.name);
    expect(free).toContain("freeFunc");
  });

  it("extracts call edges including bare, navigation, and constructor calls", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const edges = g.calls.map((c) => `${c.caller}->${c.callee}`);

    // Bare call inside method: shout() calls print() and greet() and uppercased()
    expect(edges).toContain("shout->print");
    expect(edges).toContain("shout->greet");
    expect(edges).toContain("shout->uppercased");

    // Static + self navigation calls in boot()
    expect(edges).toContain("boot->staticHello");
    expect(edges).toContain("boot->beep");

    // self.serial = serial is an assignment, NOT a call — must not appear
    expect(edges.find((e) => e.startsWith("init->"))).toBeFalsy();

    // Extension method wave() calls shout()
    expect(edges).toContain("wave->shout");

    // Free function: constructor call (Robot()) + chained method calls
    expect(edges).toContain("freeFunc->Robot");   // constructor as bare call
    expect(edges).toContain("freeFunc->boot");
    expect(edges).toContain("freeFunc->greet");
  });

  it("emits exports for top-level types", () => {
    const { tree } = parseFile(FIXTURE);
    const g = extractSwift(tree.rootNode, FIXTURE);
    const exportedNames = g.exports.map((e) => e.name).sort();
    expect(exportedNames).toEqual(["Color", "Greeter", "Person", "Robot"]);
  });
});

describe("edge cases", () => {
  it("handles an empty file", () => {
    const tree = parser.parse("");
    const g = extractSwift(tree.rootNode, "/empty.swift");
    expect(g.defines).toEqual([]);
    expect(g.calls).toEqual([]);
    expect(g.imports).toEqual([]);
  });

  it("handles a file with only a free function", () => {
    const tree = parser.parse(`func solo() { print("ok") }`);
    const g = extractSwift(tree.rootNode, "/solo.swift");
    expect(g.defines).toEqual([
      expect.objectContaining({ name: "solo", kind: "function" }),
    ]);
    expect(g.calls).toEqual([{ caller: "solo", callee: "print" }]);
  });
});
