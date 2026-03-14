import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Window } from 'happy-dom';

/**
 * Advanced extension to generate C# code 
 * starting from Mermaid UML diagrams (Class Diagram).
 */

enum EntityType {
    Class,
    Interface,
    AbstractClass,
    Enum
}

interface Property {
    visibility: string;
    name: string;
    type: string;
    isStatic: boolean;
    doc?: string;
}

interface Method {
    visibility: string;
    name: string;
    returnType: string;
    params: string;
    isAbstract: boolean;
    isStatic: boolean;
    doc?: string;
}

interface Entity {
    name: string;
    type: EntityType;
    properties: Property[];
    methods: Method[];
    extends: string[];
    implements: string[];
    enumValues: string[];
    doc?: string;
}

// Global reference for the dynamically loaded Mermaid instance
let mermaidInstance: any = null;

export function activate(context: vscode.ExtensionContext) {
    
    // Register the command IMMEDIATELY synchronously to avoid the "command not found" error
    let disposable = vscode.commands.registerCommand('mermaid-to-code.generate', async () => {
        
        // "Lazy" initialization (executed only the first time you click the command)
        if (!mermaidInstance) {
            try {
                // 1. DOM Configuration with happy-dom (Resolves the JSDOM "ENOENT" bug)
                const window = new Window();
                (global as any).window = window;
                (global as any).document = window.document;
                (global as any).DOMParser = window.DOMParser;

                // Fix for the "Cannot set property navigator" error in modern Node.js environments
                Object.defineProperty(global, 'navigator', {
                    value: window.navigator,
                    configurable: true,
                    writable: true
                });

                // 2. Dynamically import Mermaid
                const mermaidModule = await import('mermaid');
                mermaidInstance = mermaidModule.default || mermaidModule;
                mermaidInstance.initialize({ startOnLoad: false });
            } catch (err: any) {
                console.error("Fatal error while loading Mermaid:", err);
                vscode.window.showErrorMessage(`Library initialization error: ${err.message || err}`);
                return;
            }
        }

        const editor = vscode.window.activeTextEditor;

        if (!editor || editor.document.languageId !== 'markdown') {
            vscode.window.showErrorMessage('Please open a Markdown file containing a Mermaid diagram.');
            return;
        }

        const text = editor.document.getText();
        
        try {
            const entitiesMap = await parseMermaidClassDiagramOfficial(text, mermaidInstance);

            if (entitiesMap.size === 0) {
                vscode.window.showWarningMessage('No Mermaid diagram or class found in the file.');
                return;
            }

            const folderPath = path.dirname(editor.document.uri.fsPath);
            
            entitiesMap.forEach((entity, name) => {
                const content = generateCSharpCode(entity);
                const filePath = path.join(folderPath, `${name}.cs`);
                
                fs.writeFileSync(filePath, content);
            });
            vscode.window.showInformationMessage(`Successfully generated ${entitiesMap.size} C# file(s) in: ${folderPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Error during Mermaid parsing or generation: ${error}`);
        }
    });

    context.subscriptions.push(disposable);
}

/**
 * Extracts mermaid code blocks by reading text line by line.
 */
function extractMermaidDiagrams(text: string): string[] {
    const blocks: string[] = [];
    const lines = text.split('\n');
    let isInsideMermaid = false;
    let currentBlock: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        if (line.startsWith('```mermaid')) {
            isInsideMermaid = true;
            currentBlock = [];
        } else if (isInsideMermaid && line.startsWith('```')) {
            isInsideMermaid = false;
            const diagramText = currentBlock.join('\n');
            // We only care about class diagrams
            if (diagramText.includes('classDiagram')) {
                blocks.push(diagramText);
            }
        } else if (isInsideMermaid) {
            currentBlock.push(lines[i]); 
        }
    }
    
    return blocks;
}

/**
 * Pre-processes the diagram by extracting HTML comments <!-- ... -->
 * and associates them with the immediately following class or member (method/property).
 */
function preprocessMermaidAndExtractDocs(diagramContent: string) {
    const classDocs = new Map<string, string>();
    const memberDocs = new Map<string, Map<string, string>>();
    const cleanLines: string[] = [];

    let currentClass = "";
    let pendingComment = "";
    let inComment = false;
    let commentBuffer: string[] = [];

    const lines = diagramContent.split('\n');

    // Keeps track of the current class scope
    function updateCurrentClass(line: string) {
        let classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)/);
        if (classMatch) {
            currentClass = classMatch[1];
        } else if (line.includes('}')) {
            currentClass = "";
        }
    }

    // Links a found comment to either a class or a member
    function associateComment(line: string, comment: string) {
        let targetClass = currentClass;
        let isClassDef = false;
        let classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)/);

        // Check if the comment is right above a class definition
        if (classMatch) {
            targetClass = classMatch[1];
            currentClass = targetClass;
            isClassDef = true;
        } else if (line.includes('}')) {
            currentClass = "";
            return;
        }

        if (isClassDef) {
            classDocs.set(targetClass, comment);
        } else {
            // Check for standalone member definition (e.g., ClassName : +property)
            let memberStr = line;
            const standaloneMatch = line.match(/^([a-zA-Z0-9_]+)\s*:\s*(.+)$/);
            if (standaloneMatch) {
                targetClass = standaloneMatch[1];
                memberStr = standaloneMatch[2].trim();
            }

            if (targetClass && memberStr.trim().length > 0) {
                if (!memberDocs.has(targetClass)) {
                    memberDocs.set(targetClass, new Map<string, string>());
                }
                const normalizedKey = memberStr.replace(/\s+/g, '');
                memberDocs.get(targetClass)!.set(normalizedKey, comment);
            }
        }
    }

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i].trim();
        const originalLine = lines[i];

        if (inComment) {
            const endIdx = line.indexOf('-->');
            if (endIdx !== -1) {
                commentBuffer.push(line.substring(0, endIdx).trim());
                const newComment = commentBuffer.filter(c => c).join('\n').trim();
                pendingComment = pendingComment ? pendingComment + '\n' + newComment : newComment;
                inComment = false;
                
                let remaining = line.substring(endIdx + 3).trim();
                if (remaining) {
                    cleanLines.push(remaining);
                    associateComment(remaining, pendingComment);
                    pendingComment = "";
                }
            } else {
                commentBuffer.push(line);
            }
            continue;
        }

        const startIdx = line.indexOf('<!--');
        if (startIdx !== -1) {
            const endIdx = line.indexOf('-->', startIdx + 4);
            if (endIdx !== -1) {
                // Single line comment
                const extractedComment = line.substring(startIdx + 4, endIdx).trim();
                pendingComment = pendingComment ? pendingComment + '\n' + extractedComment : extractedComment;
                
                let before = line.substring(0, startIdx).trim();
                let after = line.substring(endIdx + 3).trim();
                
                if (before) {
                    cleanLines.push(before);
                    associateComment(before, pendingComment);
                    pendingComment = ""; 
                } else if (after) {
                    cleanLines.push(after);
                    associateComment(after, pendingComment);
                    pendingComment = "";
                }
                continue;
            } else {
                // Multi-line comment starting
                inComment = true;
                commentBuffer = [line.substring(startIdx + 4).trim()];
                let before = line.substring(0, startIdx).trim();
                if (before) {
                    cleanLines.push(before);
                    associateComment(before, pendingComment);
                    pendingComment = "";
                }
                continue;
            }
        }

        if (!line) {
            cleanLines.push(originalLine);
            continue;
        }

        cleanLines.push(originalLine);

        if (pendingComment) {
            associateComment(line, pendingComment);
            pendingComment = "";
        } else {
            updateCurrentClass(line);
        }
    }

    return {
        cleanDiagram: cleanLines.join('\n'),
        classDocs,
        memberDocs
    };
}

/**
 * Parses the Markdown text and builds the UML entity AST
 * delegating the actual parsing to the official Mermaid library.
 */
async function parseMermaidClassDiagramOfficial(text: string, mermaidLib: any): Promise<Map<string, Entity>> {
    const entities = new Map<string, Entity>();

    const getEntity = (name: string): Entity => {
        if (!entities.has(name)) {
            entities.set(name, { 
                name, 
                type: EntityType.Class, 
                properties: [], 
                methods: [], 
                extends: [], 
                implements: [], 
                enumValues: [] 
            });
        }
        return entities.get(name)!;
    };

    const diagrams = extractMermaidDiagrams(text);

    for (const diagramContent of diagrams) {
        try {
            // First extract docstring comments, cleaning the code for Mermaid parsing
            const { cleanDiagram, classDocs, memberDocs } = preprocessMermaidAndExtractDocs(diagramContent);
            
            // Extract Mermaid class notes (e.g., note for Duck "can fly<br>can swim")
            const noteRegex = /note\s+for\s+([a-zA-Z0-9_]+)\s+"([^"]+)"/g;
            let noteMatch;
            while ((noteMatch = noteRegex.exec(cleanDiagram)) !== null) {
                const className = noteMatch[1];
                const rawNote = noteMatch[2];
                // Replace Mermaid's <br>, <br/>, or <br /> with actual line breaks for the docstring
                const cleanNote = rawNote.replace(/<br\s*\/?>/gi, '\n');

                if (classDocs.has(className)) {
                    classDocs.set(className, classDocs.get(className) + '\n' + cleanNote);
                } else {
                    classDocs.set(className, cleanNote);
                }
            }

            const diagram = await mermaidLib.mermaidAPI.getDiagramFromText(cleanDiagram);
            const db = (diagram as any).db;
            
            if (!db || typeof db.getClasses !== 'function') continue;

            const parsedClasses = db.getClasses();
            const parsedRelations = db.getRelations();

            let classesArray: [string, any][] = [];
            if (parsedClasses instanceof Map) {
                classesArray = Array.from(parsedClasses.entries());
            } else if (parsedClasses && typeof parsedClasses === 'object') {
                classesArray = Object.entries(parsedClasses);
            }

            // 1. Processing of Classes and their Members (Properties, Methods, Modifiers)
            for (const [className, classData] of classesArray) {
                const entity = getEntity(className);

                // Assigns the class DocString (if present)
                if (classDocs.has(className)) {
                    entity.doc = classDocs.get(className);
                }
                const classMemberDocs = memberDocs.get(className);

                if (classData.annotations && classData.annotations.length > 0) {
                    const ann = classData.annotations[0].toLowerCase();
                    if (ann === 'interface') entity.type = EntityType.Interface;
                    else if (ann === 'enumeration') entity.type = EntityType.Enum;
                    else if (ann === 'abstract') entity.type = EntityType.AbstractClass;
                }

                const members = classData.members || [];
                for (const memberObj of members) {
                    let memberStr = typeof memberObj === 'string' ? memberObj : memberObj.id || memberObj.text || '';
                    
                    // Correct reconstruction from AST metadata for properties
                    if (typeof memberObj === 'object' && !Array.isArray(memberObj)) {
                        let vis = memberObj.visibility || '';
                        let type = memberObj.type ? memberObj.type + ' ' : '';
                        let name = memberObj.name || memberObj.id || '';
                        let classifier = memberObj.classifier || '';
                        memberStr = `${vis}${type}${name}${classifier}`;
                    }
                    if (memberStr) parseMember(memberStr, entity, classMemberDocs);
                }

                const methods = classData.methods || [];
                for (const methodObj of methods) {
                    let methodStr = typeof methodObj === 'string' ? methodObj : methodObj.id || methodObj.text || '';
                    
                    // Correct reconstruction from AST metadata for methods (forcing parentheses)
                    if (typeof methodObj === 'object' && !Array.isArray(methodObj)) {
                        let vis = methodObj.visibility || '';
                        let retType = methodObj.type || methodObj.returnType ? (methodObj.type || methodObj.returnType) + ' ' : '';
                        let name = methodObj.name || methodObj.id || '';
                        let params = methodObj.parameters !== undefined ? methodObj.parameters : '';
                        let classifier = methodObj.classifier || '';
                        
                        if (name.includes('(')) {
                            methodStr = `${vis}${retType}${name}${classifier}`;
                        } else {
                            methodStr = `${vis}${retType}${name}(${params})${classifier}`;
                        }
                    } else if (methodStr && !methodStr.includes('(')) {
                        methodStr += '()'; // If it is a missing raw string, force it to be a method
                    }
                    if (methodStr) parseMember(methodStr, entity, classMemberDocs);
                }
            }

            let relationsArray: any[] = [];
            if (Array.isArray(parsedRelations)) {
                relationsArray = parsedRelations;
            } else if (parsedRelations instanceof Map) {
                relationsArray = Array.from(parsedRelations.values());
            } else if (parsedRelations && typeof parsedRelations === 'object') {
                relationsArray = Object.values(parsedRelations);
            }

            // 2. Processing of Advanced UML Relationships
            for (const rel of relationsArray) {
                const id1 = rel.id1?.trim();
                const id2 = rel.id2?.trim();
                if (!id1 || !id2) continue;
                
                const r = rel.relation;
                const lineType = String(r.lineType).toLowerCase();
                const type1 = String(r.type1).toLowerCase();
                const type2 = String(r.type2).toLowerCase();

                const isDotted = lineType === '1' || lineType === 'dotted' || lineType === 'dashed';
                
                // Official Mermaid UML code mapping:
                // '1' = Extension/Inheritance (<|--)
                const isType1Ext = type1 === '1' || type1 === 'extension';
                const isType2Ext = type2 === '1' || type2 === 'extension';

                // '0' = Aggregation (o--), '2' = Composition (*--), '3' or '4' = Dependency/Association
                const isType1Comp = type1 === '0' || type1 === 'aggregation' || type1 === '2' || type1 === 'composition' || type1 === '3' || type1 === 'dependency' || type1 === 'association' || type1 === '4';
                const isType2Comp = type2 === '0' || type2 === 'aggregation' || type2 === '2' || type2 === 'composition' || type2 === '3' || type2 === 'dependency' || type2 === 'association' || type2 === '4';

                // Apply Inheritance
                if (isType1Ext) {
                    if (isDotted) getEntity(id2).implements.push(id1);
                    else getEntity(id2).extends.push(id1);
                } 
                if (isType2Ext) {
                    if (isDotted) getEntity(id1).implements.push(id2);
                    else getEntity(id1).extends.push(id2);
                }

                // Automatic Property Generation for Composition/Aggregation/Association
                if (isType1Comp) {
                    const propName = id2;
                    if (!getEntity(id1).properties.some(p => p.name.toLowerCase() === propName.toLowerCase())) {
                        getEntity(id1).properties.push({ visibility: 'public', name: propName, type: id2, isStatic: false });
                    }
                }
                if (isType2Comp) {
                    const propName = id1;
                    if (!getEntity(id2).properties.some(p => p.name.toLowerCase() === propName.toLowerCase())) {
                        getEntity(id2).properties.push({ visibility: 'public', name: propName, type: id1, isStatic: false });
                    }
                }
            }

        } catch (err) {
            console.error("Error in Mermaid parser: ", err);
        }
    }

    return entities;
}

/**
 * Parses a single member string and assigns it to the entity.
 */
function parseMember(memberStr: string, entity: Entity, rawMemberDocs?: Map<string, string>) {
    let cleanStr = memberStr.trim();
    let docStr: string | undefined = undefined;

    // Associates the correct DocString based on normalized text
    if (rawMemberDocs) {
        const normalizedQuery = cleanStr.replace(/\s+/g, '');
        // Priority to exact matching
        if (rawMemberDocs.has(normalizedQuery)) {
            docStr = rawMemberDocs.get(normalizedQuery);
        } else {
            // Fallback: permissive match ignoring any visibility added or removed by Mermaid
            const queryNoVis = normalizedQuery.replace(/^[+#-~]/, '');
            for (const [key, val] of rawMemberDocs.entries()) {
                const keyNoVis = key.replace(/^[+#-~]/, '');
                if (keyNoVis === queryNoVis) {
                    docStr = val;
                    break;
                }
            }
        }
    }

    // Check for inner annotations
    if (cleanStr.startsWith('<<') && cleanStr.endsWith('>>')) {
        const annotation = cleanStr.substring(2, cleanStr.length - 2).toLowerCase();
        if (annotation === 'interface') entity.type = EntityType.Interface;
        else if (annotation === 'enumeration') entity.type = EntityType.Enum;
        else if (annotation === 'abstract') entity.type = EntityType.AbstractClass;
        return;
    }

    if (entity.type === EntityType.Enum) {
        entity.enumValues.push(cleanStr);
        return;
    }

    // Identifies static members ($)
    let isStatic = false;
    if (cleanStr.includes('$')) {
        isStatic = true;
        cleanStr = cleanStr.replace('$', '').trim();
    }

    // Identifies abstract members (*)
    let isAbstract = false;
    if (cleanStr.endsWith('*')) {
        isAbstract = true;
        cleanStr = cleanStr.substring(0, cleanStr.length - 1).trim();
    }

    // Visibility: detects if it was explicitly inserted
    let visibility = 'public';
    let hasExplicitVisibility = false;

    if (cleanStr.startsWith('-')) { visibility = 'private'; hasExplicitVisibility = true; }
    else if (cleanStr.startsWith('#')) { visibility = 'protected'; hasExplicitVisibility = true; }
    else if (cleanStr.startsWith('~')) { visibility = 'internal'; hasExplicitVisibility = true; }
    else if (cleanStr.startsWith('+')) { visibility = 'public'; hasExplicitVisibility = true; }
    
    if (hasExplicitVisibility) {
        cleanStr = cleanStr.substring(1).trim();
    }

    if (cleanStr.includes('(')) {
        // Method parsing
        const parenStart = cleanStr.indexOf('(');
        const parenEnd = cleanStr.lastIndexOf(')');
        
        const beforeParen = cleanStr.substring(0, parenStart).trim();
        const params = cleanStr.substring(parenStart + 1, parenEnd).trim();
        const afterParen = cleanStr.substring(parenEnd + 1).trim();

        const beforeParts = beforeParen.split(' ').filter(p => p.length > 0);
        const name = beforeParts.pop() || 'Method';
        
        // Safe extraction of return type: if missing or empty, force "void"
        const extractedType = beforeParts.join(' ').trim() || afterParen.trim();
        const returnType = extractedType !== '' ? extractedType : 'void';

        entity.methods.push({ visibility, name, returnType, params, isAbstract, isStatic, doc: docStr });
    } else {
        // Property or Field parsing
        let name = 'Property';
        let type = 'object';

        if (cleanStr.includes(':')) {
            const parts = cleanStr.split(':');
            name = parts[0].trim();
            type = parts[1].trim();
        } else {
            const parts = cleanStr.split(' ').filter(p => p.length > 0);
            name = parts.pop() || 'Property';
            type = parts.join(' ') || 'object';
        }

        // C# Rule: if visibility wasn't forced and the name is in camelCase, 
        // default it to a 'private' field. Otherwise, it keeps the basic logic (public).
        if (!hasExplicitVisibility && /^[a-z_]/.test(name)) {
            visibility = 'private';
        }

        entity.properties.push({ visibility, name, type, isStatic, doc: docStr });
    }
}

/**
 * Generates the C# code based on the entity AST.
 */
function generateCSharpCode(entity: Entity): string {
    let code = `/**\n * Auto-generated from Mermaid UML diagram\n */\n`;
    code += `using System;\nusing System.Collections.Generic;\n\n`;
    code += `namespace MermaidGenerated\n{\n`;

    const indent = '    '; 

    // Generate Enum
    if (entity.type === EntityType.Enum) {
        if (entity.doc) {
            code += `${indent}/// <summary>\n`;
            entity.doc.split('\n').forEach(line => code += `${indent}/// ${line}\n`);
            code += `${indent}/// </summary>\n`;
        }
        code += `${indent}public enum ${entity.name}\n${indent}{\n`;
        entity.enumValues.forEach(v => code += `${indent}    ${v},\n`);
        code += `${indent}}\n}\n`;
        return code;
    }

    let declaration = `${indent}public `;
    if (entity.type === EntityType.Interface) declaration += `interface `;
    else if (entity.type === EntityType.AbstractClass) declaration += `abstract class `;
    else declaration += `class `;

    declaration += entity.name;

    const parents = [];
    if (entity.extends.length > 0) parents.push(...entity.extends);
    if (entity.implements.length > 0 && entity.type !== EntityType.Interface) parents.push(...entity.implements);
    
    const uniqueParents = Array.from(new Set(parents));

    if (uniqueParents.length > 0) {
        declaration += ` : ${uniqueParents.join(', ')}`;
    }

    // Inserts Class docstring
    if (entity.doc) {
        code += `${indent}/// <summary>\n`;
        entity.doc.split('\n').forEach(line => code += `${indent}/// ${line}\n`);
        code += `${indent}/// </summary>\n`;
    }
    code += `${declaration}\n${indent}{\n`;

    // Generation of Fields and Properties
    entity.properties.forEach(prop => {
        const vis = entity.type === EntityType.Interface ? '' : `${prop.visibility} `;
        const stat = prop.isStatic ? 'static ' : '';
        // Checks if the member starts with a lowercase letter or underscore (camelCase) -> Field
        const isCamelCase = /^[a-z_]/.test(prop.name);

        // Inserts Property docstring
        if (prop.doc) {
            code += `${indent}    /// <summary>\n`;
            prop.doc.split('\n').forEach(line => code += `${indent}    /// ${line}\n`);
            code += `${indent}    /// </summary>\n`;
        }

        if (isCamelCase && entity.type !== EntityType.Interface) {
            code += `${indent}    ${vis}${stat}${mapType(prop.type)} ${prop.name};\n`;
        } else {
            code += `${indent}    ${vis}${stat}${mapType(prop.type)} ${prop.name} { get; set; }\n`;
        }
    });

    if (entity.properties.length > 0 && entity.methods.length > 0) code += '\n';

    // Generation of Methods
    entity.methods.forEach(method => {
        const vis = entity.type === EntityType.Interface ? '' : `${method.visibility} `;
        const stat = method.isStatic ? 'static ' : '';
        const abs = (entity.type === EntityType.AbstractClass && method.isAbstract) ? 'abstract ' : '';
        
        // Check if the method is a Constructor
        const isConstructor = method.name === entity.name;
        
        let signature = '';
        if (isConstructor) {
            // Constructors do not have a return type and cannot be abstract
            signature = `${vis}${stat}${method.name}(${method.params})`;
        } else {
            signature = `${vis}${stat}${abs}${mapType(method.returnType)} ${method.name}(${method.params})`;
        }
        
        // Inserts Method docstring
        if (method.doc) {
            code += `${indent}    /// <summary>\n`;
            method.doc.split('\n').forEach(line => code += `${indent}    /// ${line}\n`);
            code += `${indent}    /// </summary>\n`;
        }

        if (entity.type === EntityType.Interface || (entity.type === EntityType.AbstractClass && method.isAbstract && !isConstructor)) {
            code += `${indent}    ${signature};\n`; 
        } else {
            if (isConstructor) {
                code += `${indent}    ${signature}\n${indent}    {\n${indent}        // TODO: Initialize constructor\n${indent}    }\n\n`; 
            } else {
                code += `${indent}    ${signature}\n${indent}    {\n${indent}        // TODO: Implementation\n${indent}        throw new NotImplementedException();\n${indent}    }\n\n`; 
            }
        }
    });

    code += `${indent}}\n}\n`;
    return code;
}

/**
 * Maps Mermaid/generic types to proper C# types.
 */
function mapType(type: string): string {
    // Safety fallback if type arrives empty
    if (!type || type.trim() === '') return 'void';

    // Generics (List~int~ -> List<int>)
    let normalizedType = type.replace(/~([^~]+)~/g, '<$1>');

    const t = normalizedType.toLowerCase();
    
    if (t === 'string' || t === 'bool' || t === 'void' || t === 'int' || t === 'double' || t === 'float' || t === 'long' || t === 'decimal') return t;
    if (t === 'boolean') return 'bool';
    if (t === 'number') return 'double'; 
    if (t === 'any' || t === 'object') return 'object';
    if (t === 'date' || t === 'datetime') return 'DateTime';

    return normalizedType; 
}

export function deactivate() {}