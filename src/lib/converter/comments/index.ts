import * as ts from "typescript";
import { Comment, ReflectionKind } from "../../models";
import { assertNever, Logger } from "../../utils";
import { nicePath } from "../../utils/paths";
import { lexBlockComment } from "./blockLexer";
import { discoverComment, discoverSignatureComment } from "./discovery";
import { parseComment } from "./parser";

export interface CommentParserConfig {
    blockTags: Set<string>;
    inlineTags: Set<string>;
    modifierTags: Set<string>;
}

const commentCache = new WeakMap<ts.SourceFile, Map<number, Comment>>();

function getCommentWithCache(
    discovered: [ts.SourceFile, ts.CommentRange] | undefined,
    config: CommentParserConfig,
    logger: Logger
) {
    if (!discovered) return;

    const [file, range] = discovered;
    const cache = commentCache.get(file) || new Map<number, Comment>();
    if (cache?.has(range.pos)) {
        return cache.get(range.pos)!.clone();
    }

    const line = ts.getLineAndCharacterOfPosition(file, range.pos).line + 1;
    const warning = (warning: string) =>
        logger.warn(
            `${warning} in comment at ${nicePath(file.fileName)}:${line}.`
        );

    let comment: Comment;
    switch (range.kind) {
        case ts.SyntaxKind.MultiLineCommentTrivia:
            comment = parseComment(
                lexBlockComment(file.text, range.pos, range.end),
                config,
                warning
            );
            break;
        case ts.SyntaxKind.SingleLineCommentTrivia:
            throw "GERRIT FIX ME"; // GERRIT
        default:
            assertNever(range.kind);
    }

    cache.set(range.pos, comment);
    commentCache.set(file, cache);

    return comment.clone();
}

export function getComment(
    symbol: ts.Symbol,
    kind: ReflectionKind,
    config: CommentParserConfig,
    logger: Logger
): Comment | undefined {
    const comment = getCommentWithCache(
        discoverComment(symbol, kind, logger),
        config,
        logger
    );

    if (symbol.declarations?.some(ts.isSourceFile) && comment) {
        // Module comment, make sure it is tagged with @packageDocumentation or @module.
        // If it isn't then the comment applies to the first statement in the file, so throw it away.
        if (
            !comment.hasModifier("@packageDocumentation") &&
            !comment.getTag("@module")
        ) {
            return;
        }
    }

    if (!symbol.declarations?.some(ts.isSourceFile) && comment) {
        // Ensure module comments are not attached to non-module reflections.
        if (
            comment.hasModifier("@packageDocumentation") ||
            comment.getTag("@module")
        ) {
            return;
        }
    }

    return comment;
}

export function getSignatureComment(
    declaration: ts.SignatureDeclaration | ts.JSDocSignature,
    config: CommentParserConfig,
    logger: Logger
): Comment | undefined {
    return getCommentWithCache(
        discoverSignatureComment(declaration),
        config,
        logger
    );
}

export function getJsDocComment(
    declaration:
        | ts.JSDocPropertyLikeTag
        | ts.JSDocCallbackTag
        | ts.JSDocTypedefTag
        | ts.JSDocTemplateTag
        | ts.JSDocEnumTag,
    config: CommentParserConfig,
    logger: Logger
): Comment | undefined {
    const file = declaration.getSourceFile();

    // First, get the whole comment. We know we'll need all of it.
    let parent: ts.Node = declaration.parent;
    while (!ts.isJSDoc(parent)) {
        parent = parent.parent;
    }

    // Then parse it.
    const comment = getCommentWithCache(
        [
            file,
            {
                kind: ts.SyntaxKind.MultiLineCommentTrivia,
                pos: parent.pos,
                end: parent.end,
            },
        ],
        config,
        logger
    )!;

    // And pull out the tag we actually care about.
    if (ts.isJSDocEnumTag(declaration)) {
        return new Comment(comment.getTag("@enum")?.content);
    }

    if (
        ts.isJSDocTemplateTag(declaration) &&
        declaration.comment &&
        declaration.typeParameters.length > 1
    ) {
        // We could just put the same comment on everything, but due to how comment parsing works,
        // we'd have to search for any @template with a name starting with the first type parameter's name
        // which feels horribly hacky.
        logger.warn(
            `TypeDoc does not support multiple type parameters defined in a single @template tag with a comment.`,
            declaration
        );
        return;
    }

    let name: string | undefined;
    if (ts.isJSDocTemplateTag(declaration)) {
        // This isn't really ideal.
        name = declaration.typeParameters[0].name.text;
    } else {
        name = declaration.name?.getText();
    }

    if (!name) {
        return;
    }

    const tag = comment.getIdentifiedTag(name, `@${declaration.tagName.text}`);

    if (!tag) {
        logger.error(
            `Failed to find JSDoc tag for ${name} after parsing comment, please file a bug report.`,
            declaration
        );
    } else {
        return new Comment(tag.content.slice());
    }
}
