import { startLanguageServer } from "langium/lsp";
import { NodeFileSystem } from "langium/node";
import { createConnection, ProposedFeatures } from "vscode-languageserver/node";
import { createDddServices } from "./ddd-module.js";

const connection = createConnection(ProposedFeatures.all);
const { shared } = createDddServices({ connection, ...NodeFileSystem });
startLanguageServer(shared);
