import * as vscode from "vscode";

let regex = /(type|interface) (.+)( implements ((?:& )?.+))? {/g;

function groupBy<T, K extends string>(list: T[], keyGetter: (obj: T) => K) {
  const map = {} as Record<K, T[]>;
  list.forEach((item) => {
    const key = keyGetter(item);
    const collection = map[key];
    if (!collection) {
      map[key] = [item];
    } else {
      collection.push(item);
    }
  });
  return map;
}

export function activate(context: vscode.ExtensionContext) {
  let diagnosticCollection =
    vscode.languages.createDiagnosticCollection("trustfall-linter");

  const doCheck = () => {
    const warnOnForgetToFullyImplementDependents = vscode.workspace
      .getConfiguration("trustfall-linter")
      .get("warnOnForgetToFullyImplementDependents");
    if (!warnOnForgetToFullyImplementDependents) {
      return;
    }
    let editor = vscode.window.activeTextEditor;
    if (editor) {
      let document = editor.document;
      let text = document.getText();

      const typeOrInterface2Implemented: Record<string, string[]> = {};

      for (const stmt of text.match(regex) ?? []) {
        typeOrInterface2Implemented[
          stmt.match(/^(?:type|interface) ([a-zA-Z0-9_]+) /)![1]
        ] = stmt.match(/implements ([\w\s&]+) {/)?.[1]?.split(" & ") ?? [];
      }

      let diagnostics: vscode.Diagnostic[] = [];
      for (const [typeOrInterface, implemented] of Object.entries(
        typeOrInterface2Implemented
      )) {
        const grouped = groupBy(implemented, (k) => k);
        // implemented the same thing multiple times
        for (const entry of Object.entries(grouped)) {
          if (entry[1].length === 1) {
            continue;
          }

          const match = new RegExp(
            "(?:type|interface) " + typeOrInterface
          ).exec(text)!;

          let lastFound = match.index + match[0].length;
          let nextLine = text.indexOf("\n", lastFound);
          let i = 1;

          while (
            text.indexOf(entry[0], lastFound) > -1 &&
            nextLine > text.indexOf(entry[0], lastFound)
          ) {
            const found = text.indexOf(entry[0], lastFound);
            diagnostics.push(
              new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(found),
                  document.positionAt(found + entry[0].length)
                ),
                `You implemented "${
                  entry[0]
                }" multiple times for "${typeOrInterface}". This is ${i++} / ${
                  entry[1].length
                }.`,
                vscode.DiagnosticSeverity.Error
              )
            );
            lastFound = found + 1;
          }
        }

        for (const impl of implemented) {
          // implementing something that isn't declared in this file
          if (!typeOrInterface2Implemented[impl]) {
            const match = new RegExp(
              "(?:type|interface) " + typeOrInterface
            ).exec(text)!;
            diagnostics.push(
              new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(text.indexOf(impl, match.index)),
                  document.positionAt(
                    text.indexOf(impl, match.index) + impl.length
                  )
                ),
                `You implemented "${impl}", but it's not in this file.`,
                vscode.DiagnosticSeverity.Error
              )
            );
            continue;
          }

          let difference = typeOrInterface2Implemented[impl].filter(
            (x) => !implemented.includes(x)
          );
          // if (typeOrInterface === "ASTString") {
          //   console.log([impl, difference]);
          // }
          if (difference.length > 0) {
            const match = new RegExp(
              "(?:type|interface) " + typeOrInterface
            ).exec(text)!;
            diagnostics.push(
              new vscode.Diagnostic(
                new vscode.Range(
                  document.positionAt(match.index),
                  document.positionAt(match.index + match[0].length)
                ),
                `You forgot to also implement ${difference
                  .map((x) => `"${x}"`)
                  .join(", ")} that "${impl}" implements.`,
                vscode.DiagnosticSeverity.Error
              )
            );
          }
        }
      }

      let lastOutputMispelled = 0;
      while (text.indexOf("@ouput", lastOutputMispelled) > -1) {
        const found = text.indexOf("@ouput", lastOutputMispelled);
        diagnostics.push(
          new vscode.Diagnostic(
            new vscode.Range(
              document.positionAt(found),
              document.positionAt(found + "@ouput".length)
            ),
            `Looks like you misspelled @output as @ouput.`,
            vscode.DiagnosticSeverity.Error
          )
        );
        lastOutputMispelled = found + 1;
      }

      if (/.+queries.+\.ron/.test(document.fileName)) {
        const matched: string[] = [
          ...new Set(
            [
              ...text.matchAll(
                /@filter\(op: "[a-zA-Z0-9_=!><]+", value: \[([a-zA-Z0-9_\$\", ]+)\]\)/g
              ),
            ]
              .map((x) => x[1].replace(/"/g, "").split(", "))
              .flatMap((x) => x)
          ),
        ];
        // ensure there is an argument in the file for each $arg
        for (const filter of matched) {
          if (filter.charAt(0) === "$") {
            const filterRE = new RegExp(
              `"${filter.substring(1)}": [a-zA-Z0-9_]+\\([a-zA-Z0-9_"]+\\),?\n` // substring(1) to get rid of '$'
            );
            if (text.match(filterRE) === null) {
              let lastMatch = 0;
              while (text.indexOf(filter, lastMatch) > -1) {
                const i = text.indexOf(filter);
                diagnostics.push(
                  new vscode.Diagnostic(
                    new vscode.Range(
                      document.positionAt(i),
                      document.positionAt(i + filter.length)
                    ),
                    `Can't find argument value for "${filter}" in the file.`,
                    vscode.DiagnosticSeverity.Error
                  )
                );
                lastMatch = i + 1;
              }
            }
          }
        }
      }

      diagnosticCollection.clear();

      diagnosticCollection.set(document.uri, diagnostics);
    }
  };

  vscode.workspace.onDidChangeTextDocument(
    (event) => doCheck(),
    null,
    context.subscriptions
  );
  vscode.window.onDidChangeActiveTextEditor(
    (event) => doCheck(),
    null,
    context.subscriptions
  );

  vscode.workspace.onWillSaveTextDocument((event) => {
    const isRemoveTrailingSpacesEnabled = vscode.workspace
      .getConfiguration("trustfall-linter")
      .get("removeTrailingSpacesOnSave");
    if (!isRemoveTrailingSpacesEnabled) {
      return;
    }

    const editor = vscode.window.activeTextEditor;

    if (editor) {
      let doc = editor.document;
      let edits: vscode.TextEdit[] = [];

      for (let i = 0; i < doc.lineCount; i++) {
        let line = doc.lineAt(i);
        if (line.text.endsWith(" ")) {
          let wsStart = line.text.length;
          while (line.text.charAt(wsStart - 1) === " ") {
            wsStart--;
          }

          let range = new vscode.Range(
            new vscode.Position(i, wsStart),
            new vscode.Position(i, line.text.length)
          );
          edits.push(vscode.TextEdit.delete(range));
        }
      }

      let wsEdit = new vscode.WorkspaceEdit();
      wsEdit.set(doc.uri, edits); // give the edits
      vscode.workspace.applyEdit(wsEdit); // apply the edits
    }
  });

  doCheck(); // run on startup
}

export function deactivate() {}
