import { createRequire } from 'module';
import { dirname, resolve } from 'path';
import { runTwoSlash } from 'shiki-twoslash';
import { SourceMapConsumer } from 'source-map-js';
import { svelte2tsx } from 'svelte2tsx';
import ts from 'typescript';

/**
 * @typedef {{ line: number, character: number }} Position
 * @typedef {{ line: number, column: number }} SourceMapConsumerPosition
 * @typedef {(position: Position) => Position} SourceMapper
 */

const require = createRequire(import.meta.url);
const svelteTsPath = dirname(require.resolve('svelte2tsx'));
const svelteTsxFiles = ['./svelte-shims.d.ts', './svelte-jsx.d.ts', './svelte-native-jsx.d.ts'].map(
	(f) => resolve(svelteTsPath, f)
);
const { createLanguageService } = ts;

const lineBreakRegex = /\r\n?|\n/g;

/**
 * @param {string} source
 * @returns {ReturnType<typeof runTwoSlash>}
 */
export function runSvelteTwoSlash(source) {
	const code = svelte2tsx(source, {
		mode: 'ts',
		isTsFile: false
	});
	const lineOffsets = getLineOffsets(source);

	let generated = code.code;

	let prependLines = 0;

	/**@param {string} line  */
	const prependLine = (line) => {
		generated = line + '\n' + generated;

		prependLines++;
	};

	for (const path of svelteTsxFiles) {
		prependLine(`/// <reference path="${path}" />`);
	}

	const mapToOriginalPosition = createSourceMapper({
		...code.map,
		version: code.map.version.toString()
	});

	const generatedOffset = getLineOffsets(generated);

	const twoslash = runTwoSlash(generated, 'js', {
		defaultCompilerOptions: {
			checkJs: true
		},
		tsModule: {
			...ts,
			createLanguageService(...args) {
				const ls = createLanguageService(...args);
				const { getSemanticDiagnostics } = ls;

				ls.getSemanticDiagnostics = (filename) => {
					// filter out errors from generated code
					const errors = getSemanticDiagnostics(filename);
					const file = ls.getProgram()?.getSourceFile(filename);
					if (!file) {
						return errors;
					}

					const removed = checkRemovedLines(generated, file.getFullText());
					const removeLineMapper = createRemoveLineMapper(removed);
					const result = errors.filter((e) => {
						const position = positionAt(e.start, generated, generatedOffset);
						const originalPosition = mapToOriginalPosition(
							removeLineMapper.mapToOriginalPosition(position)
						);

						return originalPosition.line > 0 && originalPosition.character >= 0;
					});

					return result;
				};

				return ls;
			}
		}
	});

	const removeLinesMap = checkRemovedLines(generated, twoslash.code);
	const removedLines = removeLinesMap.getRemovedLines();
	const removeLineMapper = createRemoveLineMapper(removeLinesMap);
	const sourceRemovedLines = removedLines.map(
		(line) =>
			mapToOriginalPosition({
				line: line - prependLines,
				character: 0
			}).line
	);

	const processed = removeLinesFromSource(source, sourceRemovedLines);
	const sourceRemoveLineMap = checkRemovedLines(source, processed);
	const processedLineOffsets = getLineOffsets(processed);
	const sourceRemoveLineMapper = createRemoveLineMapper(sourceRemoveLineMap);

	const staticQuickInfos = twoslash.staticQuickInfos
		.map((quickInfo) =>
			mapTwoSlashInfo(
				mapToOriginalPosition,
				source,
				{
					...quickInfo,
					line:
						removeLineMapper.mapToOriginalPosition({
							line: quickInfo.line,
							character: quickInfo.character
						}).line - prependLines
				},
				lineOffsets
			)
		)
		.filter((info) => info.line > 0 && info.character > 0 && info.targetString !== 'render')
		.map((quickInfo) =>
			mapTwoSlashInfo(
				sourceRemoveLineMapper.mapToGeneratedPosition,
				processed,
				quickInfo,
				processedLineOffsets
			)
		);

	const errors = twoslash.errors
		.map((error) =>
			mapTwoSlashInfo(
				mapToOriginalPosition,
				source,
				{
					...error,
					line:
						removeLineMapper.mapToOriginalPosition({
							line: error.line - prependLines,
							character: error.character
						}).line - prependLines
				},
				lineOffsets
			)
		)
		.filter((info) => info.line > 0 && info.character > 0)
		.map((quickInfo) =>
			mapTwoSlashInfo(
				sourceRemoveLineMapper.mapToGeneratedPosition,
				processed,
				quickInfo,
				processedLineOffsets
			)
		);

	return {
		...twoslash,
		staticQuickInfos,
		errors,
		code: processed
	};
}

/**
 * @param {SourceMapper} mapper
 * @param {string} source
 * @param {T} position
 * @param {number[]} lineOffsets
 * @template {Position} T
 * @returns {T}
 */
function mapTwoSlashInfo(mapper, source, position, lineOffsets) {
	const originalPosition = mapper(position);
	const offset = offsetAt(originalPosition, source, lineOffsets);

	return {
		...position,
		...originalPosition,
		start: offset
	};
}

/**
 * Get the offset of the line and character position
 * @param {{line: number, character: number}} position Line and character position
 * @param {string} text The text for which the offset should be retrived
 * @param {number[]} lineOffsets number Array with offsets for each line. Computed if not given
 */
function offsetAt(position, text, lineOffsets = getLineOffsets(text)) {
	if (position.line >= lineOffsets.length) {
		return text.length;
	} else if (position.line < 0) {
		return 0;
	}
	const lineOffset = lineOffsets[position.line];
	const nextLineOffset =
		position.line + 1 < lineOffsets.length ? lineOffsets[position.line + 1] : text.length;
	return clamp(nextLineOffset, lineOffset, lineOffset + position.character);
}

/**
 *
 * @param {string} text
 * @returns
 */
function getLineOffsets(text) {
	const lineOffsets = [];
	let isLineStart = true;
	for (let i = 0; i < text.length; i++) {
		if (isLineStart) {
			lineOffsets.push(i);
			isLineStart = false;
		}
		const ch = text.charAt(i);
		isLineStart = ch === '\r' || ch === '\n';
		if (ch === '\r' && i + 1 < text.length && text.charAt(i + 1) === '\n') {
			i++;
		}
	}
	if (isLineStart && text.length > 0) {
		lineOffsets.push(text.length);
	}
	return lineOffsets;
}

/**
 *
 * @param {number} num
 * @param {number} min
 * @param {number} max
 * @returns
 */
function clamp(num, min, max) {
	return Math.max(min, Math.min(max, num));
}

/**
 * Get the line and character based on the offset
 * @param {number} offset The index of the position
 * @param {string} text The text for which the position should be retrived
 * @param lineOffsets number Array with offsets for each line. Computed if not given
 * @returns {{ line: number, character: number }}
 */
export function positionAt(offset, text, lineOffsets = getLineOffsets(text)) {
	offset = clamp(offset, 0, text.length);

	let low = 0;
	let high = lineOffsets.length;
	if (high === 0) {
		return { line: 0, character: offset };
	}

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const lineOffset = lineOffsets[mid];

		if (lineOffset === offset) {
			return { line: mid, character: 0 };
		} else if (offset > lineOffset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	// low is the least x for which the line offset is larger than the current offset
	// or array.length if no line offset is larger than the current offset
	const line = low - 1;
	return { line, character: offset - lineOffsets[line] };
}

/**
 *
 * @param {string} svelte2tsxCode
 * @param {string} twoSlashResult
 */
function checkRemovedLines(svelte2tsxCode, twoSlashResult) {
	const svelte2tsxLines = svelte2tsxCode.split(lineBreakRegex);
	const twoSlashResultLines = twoSlashResult.split(lineBreakRegex);
	let svelte2tsxIndex = 0;
	/**
	 * @type {Map<number, number>}
	 */
	const generatedToOriginal = new Map();

	for (let index = 0; index < twoSlashResultLines.length; index++) {
		const twoslashResultLine = twoSlashResultLines[index];

		const correspondIndex = svelte2tsxLines.indexOf(twoslashResultLine, svelte2tsxIndex);

		if (correspondIndex < 0) {
			break;
		}

		generatedToOriginal.set(index, correspondIndex);

		svelte2tsxIndex = correspondIndex;
	}

	const originalToGenerated = new Map(
		Array.from(generatedToOriginal).map(([generated, original]) => [original, generated])
	);

	return {
		generatedToOriginal,
		originalToGenerated,
		getRemovedLines
	};

	function getRemovedLines() {
		const lines = [];

		for (let index = 0; index < svelte2tsxLines.length; index++) {
			if (!originalToGenerated.has(index)) {
				lines.push(index);
			}
		}

		return lines;
	}
}

/**
 *
 * @param {import('source-map-js').RawSourceMap} rawSourceMap
 * @return {SourceMapper}
 */
function createSourceMapper(rawSourceMap) {
	const consumer = new SourceMapConsumer(rawSourceMap);

	return function mapToOriginalPosition(position) {
		const oneBasedPosition = consumer.originalPositionFor({
			line: position.line + 1,
			column: position.character
		});

		return {
			line: (oneBasedPosition.line ?? 0) - 1,
			character: oneBasedPosition.column ?? 0
		};
	};
}

/**
 *
 * @param {{ originalToGenerated: Map<number, number>, generatedToOriginal: Map<number, number> }} param0
 * @return {{ mapToGeneratedPosition: SourceMapper, mapToOriginalPosition: SourceMapper }}
 */
function createRemoveLineMapper({ originalToGenerated, generatedToOriginal }) {
	return {
		mapToGeneratedPosition(position) {
			const generatedLine = originalToGenerated.get(position.line);

			return {
				line: generatedLine ?? -1,
				character: position.character
			};
		},
		mapToOriginalPosition(position) {
			const line = generatedToOriginal.get(position.line);

			return {
				line: line ?? -1,
				character: position.character
			};
		}
	};
}

/**
 * @param {string} source
 * @param {number[]} removedLines
 */
function removeLinesFromSource(source, removedLines) {
	if (!removedLines.length) {
		return source;
	}

	const sourceLines = source.split(lineBreakRegex);
	return sourceLines.filter((_, index) => !removedLines.includes(index)).join('\n');
}
