import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Window } from 'happy-dom';

/**
 * Estensione avanzata per generare codice C#
 * a partire da diagrammi UML Mermaid (Class Diagram).
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

// Riferimento globale per l'istanza di Mermaid caricata dinamicamente
let mermaidInstance: any = null;

export function activate(context: vscode.ExtensionContext) {
    
    // Registriamo il comando SUBITO in modo sincrono per evitare l'errore "command not found"
    let disposable = vscode.commands.registerCommand('mermaid-to-code.generate', async () => {
        
        // Inizializzazione "Lazy" (eseguita solo la prima volta che clicchi il comando)
        if (!mermaidInstance) {
            try {
                // 1. Configurazione DOM con happy-dom (Risolve il bug di JSDOM "ENOENT")
                const window = new Window();
                (global as any).window = window;
                (global as any).document = window.document;
                (global as any).DOMParser = window.DOMParser;

                Object.defineProperty(global, 'navigator', {
                    value: window.navigator,
                    configurable: true,
                    writable: true
                });

                // 2. Importiamo Mermaid in modo dinamico
                const mermaidModule = await import('mermaid');
                mermaidInstance = mermaidModule.default || mermaidModule;
                mermaidInstance.initialize({ startOnLoad: false });
            } catch (err: any) {
                console.error("Errore fatale durante il caricamento di Mermaid:", err);
                vscode.window.showErrorMessage(`Errore di inizializzazione librerie: ${err.message || err}`);
                return;
            }
        }

        const editor = vscode.window.activeTextEditor;

        if (!editor || editor.document.languageId !== 'markdown') {
            vscode.window.showErrorMessage('Per favore, apri un file Markdown contenente un diagramma Mermaid.');
            return;
        }

        const text = editor.document.getText();
        
        try {
            const entitiesMap = await parseMermaidClassDiagramOfficial(text, mermaidInstance);

            if (entitiesMap.size === 0) {
                vscode.window.showWarningMessage('Nessun diagramma o classe Mermaid trovata nel file.');
                return;
            }

            const folderPath = path.dirname(editor.document.uri.fsPath);
            
            entitiesMap.forEach((entity, name) => {
                const content = generateCSharpCode(entity);
                const filePath = path.join(folderPath, `${name}.cs`);
                
                fs.writeFileSync(filePath, content);
            });
            vscode.window.showInformationMessage(`Generati con successo ${entitiesMap.size} file C# in: ${folderPath}`);
        } catch (error) {
            vscode.window.showErrorMessage(`Errore durante il parsing di Mermaid o la generazione: ${error}`);
        }
    });

    context.subscriptions.push(disposable);
}

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
 * Pre-processa il diagramma estraendo i commenti HTML <!-- ... -->
 * e li associa alla classe o al membro (metodo/proprietà) immediatamente successivo.
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

    function updateCurrentClass(line: string) {
        let classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)/);
        if (classMatch) {
            currentClass = classMatch[1];
        } else if (line.includes('}')) {
            currentClass = "";
        }
    }

    function associateComment(line: string, comment: string) {
        let targetClass = currentClass;
        let isClassDef = false;
        let classMatch = line.match(/^class\s+([a-zA-Z0-9_]+)/);

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
            // Estrae prima i commenti docstring pulendo il codice per Mermaid
            const { cleanDiagram, classDocs, memberDocs } = preprocessMermaidAndExtractDocs(diagramContent);
            
            // Estrae anche le note di classe di Mermaid (es. note for Duck "can fly<br>can swim")
            const noteRegex = /note\s+for\s+([a-zA-Z0-9_]+)\s+"([^"]+)"/g;
            let noteMatch;
            while ((noteMatch = noteRegex.exec(cleanDiagram)) !== null) {
                const className = noteMatch[1];
                const rawNote = noteMatch[2];
                // Sostituisce i <br>, <br/> o <br /> di Mermaid con andate a capo reali per la docstring
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

            // 1. Elaborazione delle Classi e dei loro Membri (Proprietà, Metodi, Modificatori)
            for (const [className, classData] of classesArray) {
                const entity = getEntity(className);

                // Assegna il DocString di classe (se presente)
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
                    
                    // Ricostruzione corretta dai metadati AST per le proprietà
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
                    
                    // Ricostruzione corretta dai metadati AST per i metodi (forzando le parentesi)
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
                        methodStr += '()'; // Se è una stringa grezza mancante, la forziamo a metodo
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

            // 2. Elaborazione delle Relazioni Avanzate UML
            for (const rel of relationsArray) {
                const id1 = rel.id1?.trim();
                const id2 = rel.id2?.trim();
                if (!id1 || !id2) continue;
                
                const r = rel.relation;
                const lineType = String(r.lineType).toLowerCase();
                const type1 = String(r.type1).toLowerCase();
                const type2 = String(r.type2).toLowerCase();

                const isDotted = lineType === '1' || lineType === 'dotted' || lineType === 'dashed';
                
                // Mappatura codici ufficiale Mermaid UML:
                // '1' = Estensione/Ereditarietà (<|--)
                const isType1Ext = type1 === '1' || type1 === 'extension';
                const isType2Ext = type2 === '1' || type2 === 'extension';

                // '0' = Aggregazione (o--), '2' = Composizione (*--), '3' o '4' = Dipendenza/Associazione
                const isType1Comp = type1 === '0' || type1 === 'aggregation' || type1 === '2' || type1 === 'composition' || type1 === '3' || type1 === 'dependency' || type1 === 'association' || type1 === '4';
                const isType2Comp = type2 === '0' || type2 === 'aggregation' || type2 === '2' || type2 === 'composition' || type2 === '3' || type2 === 'dependency' || type2 === 'association' || type2 === '4';

                // Applica Ereditarietà
                if (isType1Ext) {
                    if (isDotted) getEntity(id2).implements.push(id1);
                    else getEntity(id2).extends.push(id1);
                } 
                if (isType2Ext) {
                    if (isDotted) getEntity(id1).implements.push(id2);
                    else getEntity(id1).extends.push(id2);
                }

                // Generazione Automatica Proprietà per Composizione/Aggregazione/Associazione
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
            console.error("Errore nel parser di Mermaid: ", err);
        }
    }

    return entities;
}

function parseMember(memberStr: string, entity: Entity, rawMemberDocs?: Map<string, string>) {
    let cleanStr = memberStr.trim();
    let docStr: string | undefined = undefined;

    // Associa il DocString corretto in base al testo normalizzato
    if (rawMemberDocs) {
        const normalizedQuery = cleanStr.replace(/\s+/g, '');
        // Priorità al matching esatto
        if (rawMemberDocs.has(normalizedQuery)) {
            docStr = rawMemberDocs.get(normalizedQuery);
        } else {
            // Fallback: match permissivo ignorando eventuali visibilità aggiunte o rimosse da Mermaid
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

    // Identifica membri statici ($)
    let isStatic = false;
    if (cleanStr.includes('$')) {
        isStatic = true;
        cleanStr = cleanStr.replace('$', '').trim();
    }

    // Identifica membri astratti (*)
    let isAbstract = false;
    if (cleanStr.endsWith('*')) {
        isAbstract = true;
        cleanStr = cleanStr.substring(0, cleanStr.length - 1).trim();
    }

    // Visibilità: rileva se è stata inserita esplicitamente
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
        // Metodo
        const parenStart = cleanStr.indexOf('(');
        const parenEnd = cleanStr.lastIndexOf(')');
        
        const beforeParen = cleanStr.substring(0, parenStart).trim();
        const params = cleanStr.substring(parenStart + 1, parenEnd).trim();
        const afterParen = cleanStr.substring(parenEnd + 1).trim();

        const beforeParts = beforeParen.split(' ').filter(p => p.length > 0);
        const name = beforeParts.pop() || 'Method';
        
        // Estrazione sicura del tipo di ritorno: se assente o vuoto, forziamo "void"
        const extractedType = beforeParts.join(' ').trim() || afterParen.trim();
        const returnType = extractedType !== '' ? extractedType : 'void';

        entity.methods.push({ visibility, name, returnType, params, isAbstract, isStatic, doc: docStr });
    } else {
        // Proprietà o Field
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

        // Regola C#: se la visibilità non è stata forzata e il nome è in camelCase,
        // di default lo consideriamo un field "private". Altrimenti mantiene la logica di base (public).
        if (!hasExplicitVisibility && /^[a-z_]/.test(name)) {
            visibility = 'private';
        }

        entity.properties.push({ visibility, name, type, isStatic, doc: docStr });
    }
}

function generateCSharpCode(entity: Entity): string {
    let code = `/**\n * Auto-generato da diagramma UML Mermaid\n */\n`;
    code += `using System;\nusing System.Collections.Generic;\n\n`;
    code += `namespace MermaidGenerated\n{\n`;

    const indent = '    '; 

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

    // Inserisce il docstring di Classe
    if (entity.doc) {
        code += `${indent}/// <summary>\n`;
        entity.doc.split('\n').forEach(line => code += `${indent}/// ${line}\n`);
        code += `${indent}/// </summary>\n`;
    }
    code += `${declaration}\n${indent}{\n`;

    // Generazione Field e Proprietà
    entity.properties.forEach(prop => {
        const vis = entity.type === EntityType.Interface ? '' : `${prop.visibility} `;
        const stat = prop.isStatic ? 'static ' : '';
        
        // Verifica se il membro inizia con lettera minuscola o underscore (camelCase) -> Field
        const isCamelCase = /^[a-z_]/.test(prop.name);

        // Inserisce il docstring di Proprietà
        if (prop.doc) {
            code += `${indent}    /// <summary>\n`;
            prop.doc.split('\n').forEach(line => code += `${indent}    /// ${line}\n`);
            code += `${indent}    /// </summary>\n`;
        }

        if (isCamelCase && entity.type !== EntityType.Interface) {
            // Genera come Field: es. private int age;
            code += `${indent}    ${vis}${stat}${mapType(prop.type)} ${prop.name};\n`;
        } else {
            // Genera come Auto-Property: es. public int Age { get; set; }
            code += `${indent}    ${vis}${stat}${mapType(prop.type)} ${prop.name} { get; set; }\n`;
        }
    });

    if (entity.properties.length > 0 && entity.methods.length > 0) code += '\n';

    // Generazione Metodi
    entity.methods.forEach(method => {
        const vis = entity.type === EntityType.Interface ? '' : `${method.visibility} `;
        const stat = method.isStatic ? 'static ' : '';
        const abs = (entity.type === EntityType.AbstractClass && method.isAbstract) ? 'abstract ' : '';
        
        const signature = `${vis}${stat}${abs}${mapType(method.returnType)} ${method.name}(${method.params})`;
        
        // Inserisce il docstring di Metodo
        if (method.doc) {
            code += `${indent}    /// <summary>\n`;
            method.doc.split('\n').forEach(line => code += `${indent}    /// ${line}\n`);
            code += `${indent}    /// </summary>\n`;
        }

        if (entity.type === EntityType.Interface || (entity.type === EntityType.AbstractClass && method.isAbstract)) {
            code += `${indent}    ${signature};\n`; 
        } else {
            code += `${indent}    ${signature}\n${indent}    {\n${indent}        // TODO: Implementazione\n${indent}        throw new NotImplementedException();\n${indent}    }\n\n`; 
        }
    });

    code += `${indent}}\n}\n`;
    return code;
}

function mapType(type: string): string {
    // Fallback di sicurezza se il tipo arriva vuoto
    if (!type || type.trim() === '') return 'void';

    // Generici (List~int~ -> List<int>)
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