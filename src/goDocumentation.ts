'use strict';

import vscode = require('vscode');
import cp = require('child_process');
import path = require('path');
import { CancellationToken, TextDocumentContentProvider, Uri } from 'vscode';
import { getBinPath, getToolsEnvVars, byteOffsetAt, getFileArchive } from './util';
import { promptForMissingTool } from './goInstallTools';
import { getAllPackages } from './goPackages';

// fromEditor should indicate if the command is being invoked from an editor
// using a context menu or a keyboard shortcut, or the command is being invoked
// from the command palette manually.
export function getDocumentation(fromEditor = false): void {
	if (!fromEditor) {
		_getDocumentationForImport();
		return;
	}

	let gogetdoc = getBinPath('gogetdoc');
	if (!path.isAbsolute(gogetdoc)) {
		promptForMissingTool('gogetdoc');
		_getDocumentationForImport();
	}

	let ate = vscode.window.activeTextEditor;
	if (typeof ate !== 'undefined') {
		let document = ate.document;
		let gogetDocsFlags = ['-u', '-json', '-modified', '-pos', document.fileName + ':#' + byteOffsetAt(document, ate.selection.active).toString()];
		let p = cp.execFile(gogetdoc, gogetDocsFlags, {env: getToolsEnvVars()}, (err, stdout, stderr) => {
			try {
				let goGetDocOutput = <GoGetDocOutput>JSON.parse(stdout.toString());

				// drop the stuff before /vendor/ if we have it
				let imprt = goGetDocOutput.import.replace(/.*\/vendor\/(.*)/, '$1');

				_getDocumentationForImport(imprt);
			} catch (e) {
				_getDocumentationForImport();
			}
		});
		p.stdin.end(getFileArchive(document));
	} else {
		// we should never get here, but better safe than undefined
		_getDocumentationForImport();
	}
}

function _getDocumentationForImport(imprt?: string): void {
	if (imprt) {
		_showDocumentationForPackage(imprt);
		return;
	}

	getAllPackages().then(pkgMap => {
		let pkgs: string[] = Array.from(pkgMap.keys());
		if (pkgs.length === 0) {
			vscode.window.showInputBox({
				placeHolder: 'Please enter a package name',
			}).then(pkgInput => {
				if (!pkgInput) {
					return;
				}
				_showDocumentationForPackage(pkgInput);
			});
			return;
		}

		vscode.window.showQuickPick(_devendorPkgs(pkgs), {
			placeHolder: 'Please select a package',
		}).then(pkgSelected => {
			if (!pkgSelected) {
				return;
			}
			_showDocumentationForPackage(pkgSelected);
		});
	});
}

// We're looking for documentation in the local context. So lets drop any vendor
// junk and let the documentation finder figure things out.
function _devendorPkgs(pkgs: string[]): string[] {
	pkgs = pkgs.map(s => {
		return s.replace(/.*\/vendor\/(.*)/, '$1');
	});

	let seen = {};
	pkgs = pkgs.filter(s => {
		return seen.hasOwnProperty(s) ? false : (seen[s] = true);
	});

	pkgs = pkgs.sort();

	return pkgs;
}

function _showDocumentationForPackage(pkg: string): void {
	let uri = vscode.Uri.parse('godocumentation://').with({
		path: pkg,
	});

	vscode.window.showTextDocument(uri, {
		viewColumn: vscode.window.activeTextEditor.viewColumn + 1,
		preserveFocus: true,
	});
}

export class GoDocumentationContentProvider implements TextDocumentContentProvider {
	public provideTextDocumentContent(uri: Uri, token: CancellationToken): Thenable<string>|string {
		let godoc = getBinPath('godoc');
		if (!path.isAbsolute(godoc)) {
			promptForMissingTool('godoc');
			return '';
		}

		let pkg = uri.path;

		// godoc doesn't handle vendor directories correctly. So we first try
		// the local workspace vendor directory to see if there's a vendored
		// version of the package. If not, we'll return whatever godoc would
		// normally say.
		let vendorPkg = vscode.workspace.workspaceFolders[0].uri.fsPath + '/vendor/' + pkg;

		return new Promise<string>((resolve, reject) => {
			cp.execFile(godoc, [vendorPkg], {env: getToolsEnvVars()}, (err, stdout, stderr) => {
				if (_packageNotFound(stderr)) {
					return resolve('');
				} else {
					return resolve(_cleanupGodocOutput(stdout));
				}
			});
		}).then(vendorOutput => {
			if (vendorOutput !== '') {
				return vendorOutput;
			}

			return new Promise<string>((resolve, reject) => {
				cp.execFile(godoc, [pkg], {env: getToolsEnvVars()}, (err, stdout, stderr) => {
					if (_packageNotFound(stderr)) {
						return resolve('Could not find package ' + pkg);
					} else {
						return resolve(_cleanupGodocOutput(stdout));
					}
				});
			});
		});
	}
}

function _packageNotFound(stderr: string): boolean {
	let match = /cannot find package/.exec(stderr);
	return !!match;
}

function _cleanupGodocOutput(output: string): string {
	output = output.replace(/.*\n\n(PACKAGE DOCUMENTATION\n\n.*)/, '$1');
	output = output.replace(/import ".*\/vendor\/(.*?)"/, 'import "$1"');
	return output;
}

interface GoGetDocOutput {
	import: string;
}
