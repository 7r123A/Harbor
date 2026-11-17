import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const profileSource = readFileSync(
  new URL("../src/views/profile/profile.tsx", import.meta.url),
  "utf8",
);
const source = ts.createSourceFile(
  "profile.tsx",
  profileSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function visit(node: ts.Node, predicate: (candidate: ts.Node) => boolean): ts.Node[] {
  const matches = predicate(node) ? [node] : [];
  return [...matches, ...node.getChildren(source).flatMap((child) => visit(child, predicate))];
}

function jsxName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText(source);
}

test("Mutual Ratings is registered in and rendered through the full profile ratings card", () => {
  const importExists = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "./mutual-ratings-card",
  );
  assert.equal(importExists, true, "full profile imports its Mutual Ratings section");

  const cardNodes = visit(
    source,
    (node) =>
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "cardNodes" &&
      !!node.initializer &&
      ts.isObjectLiteralExpression(node.initializer),
  )[0] as ts.VariableDeclaration | undefined;
  assert.ok(cardNodes?.initializer && ts.isObjectLiteralExpression(cardNodes.initializer));

  const ratingsSlot = cardNodes.initializer.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "ratings",
  );
  assert.ok(ratingsSlot && ts.isPropertyAssignment(ratingsSlot));
  const registered = visit(
    ratingsSlot.initializer,
    (node) =>
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      jsxName(node) === "MutualRatingsCard",
  );
  assert.equal(registered.length, 1, "Mutual Ratings shares the actual ratings profile card slot");

  const renderedFromLayout = visit(
    source,
    (node) =>
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "cardNodes" &&
      node.argumentExpression &&
      ts.isIdentifier(node.argumentExpression) &&
      node.argumentExpression.text === "k",
  );
  assert.ok(renderedFromLayout.length > 0, "the configured profile layout renders cardNodes[k]");
});
