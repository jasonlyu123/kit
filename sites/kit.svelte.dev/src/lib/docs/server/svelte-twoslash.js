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
const svelte_ts_path = dirname(require.resolve('svelte2tsx'));
const svelte_tsx_files = [
	'./svelte-shims.d.ts',
	'./svelte-jsx.d.ts',
	'./svelte-native-jsx.d.ts'
].map((f) => resolve(svelte_ts_path, f));

const line_break_regex = /\r\n?|\n/g;

/**
 * @param {string} source
 * @returns {ReturnType<typeof runTwoSlash>}
 */
export function run_svelte_twoSlash(source) {
	const code = svelte2tsx(source, {
		mode: 'ts',
		isTsFile: false
	});
	const line_offsets = get_line_offsets(source);

	const generated =
		svelte_tsx_files.map((file) => `/// <reference path="${file}" />\n`).join('') + code.code;
	const prepend_lines = svelte_tsx_files.length;

	const map_to_original_position = create_source_mapper({
		...code.map,
		version: code.map.version.toString()
	});

	const twoslash = runTwoSlash(generated, 'js', {
		defaultCompilerOptions: {
			checkJs: true
		},
		tsModule: decorate_ts(generated, map_to_original_position)
	});

	const remove_lines_map = check_removed_lines(generated, twoslash.code);
	const removed_lines = remove_lines_map.get_removed_lines();
	const remove_line_mapper = create_remove_line_mapper(remove_lines_map);
	const source_removed_lines = removed_lines.map(
		(line) =>
			map_to_original_position({
				line: line - prepend_lines,
				character: 0
			}).line
	);

	const processed = remove_lines_from_source(source, source_removed_lines);
	const source_remove_line_map = check_removed_lines(source, processed);
	const processed_line_offsets = get_line_offsets(processed);
	const source_remove_line_mapper = create_remove_line_mapper(source_remove_line_map);

	const static_quick_infos = Array.from(map_info_to_result(twoslash.staticQuickInfos)).filter(
		(info) => info.targetString !== 'render'
	);
	const errors = Array.from(map_info_to_result(twoslash.errors));

	return {
		...twoslash,
		staticQuickInfos: static_quick_infos,
		errors,
		code: processed
	};

	/**
	 * @template {Position} T
	 * @param {Iterable<T>} infoList
	 */
	function* map_info_to_result(infoList) {
		for (const info of infoList) {
			const line_before_line_removed = remove_line_mapper.map_to_original_position({
				line: info.line,
				character: info.character
			}).line;

			const line_without_prepend_lines = line_before_line_removed - prepend_lines;
			const info_with_original_position = map_two_slash_info(
				map_to_original_position,
				source,
				{
					...info,
					line: line_without_prepend_lines
				},
				line_offsets
			);
			const info_with_processed_position = map_two_slash_info(
				source_remove_line_mapper.map_to_generated_position,
				processed,
				info_with_original_position,
				processed_line_offsets
			);

			if (info.line > 0 && info.character > 0) {
				yield info_with_processed_position;
			}
		}
	}
}

/**
 * @param {SourceMapper} mapper
 * @param {string} source
 * @param {T} position
 * @param {number[]} line_offsets
 * @template {Position} T
 * @returns {T}
 */
function map_two_slash_info(mapper, source, position, line_offsets) {
	const original_position = mapper(position);
	const offset = offset_at(original_position, source, line_offsets);

	return {
		...position,
		...original_position,
		start: offset
	};
}

/**
 * Get the offset of the line and character position
 * @param {{line: number, character: number}} position Line and character position
 * @param {string} text The text for which the offset should be retrieved
 * @param {number[]} line_offsets number Array with offsets for each line. Computed if not given
 */
function offset_at(position, text, line_offsets = get_line_offsets(text)) {
	if (position.line >= line_offsets.length) {
		return text.length;
	} else if (position.line < 0) {
		return 0;
	}
	const line_offset = line_offsets[position.line];
	const next_line_offset =
		position.line + 1 < line_offsets.length ? line_offsets[position.line + 1] : text.length;
	return clamp(next_line_offset, line_offset, line_offset + position.character);
}

/**
 *
 * @param {string} text
 * @returns
 */
function get_line_offsets(text) {
	const line_offsets = [];
	let is_line_start = true;
	for (let i = 0; i < text.length; i++) {
		if (is_line_start) {
			line_offsets.push(i);
			is_line_start = false;
		}
		const ch = text.charAt(i);
		is_line_start = ch === '\r' || ch === '\n';
		if (ch === '\r' && i + 1 < text.length && text.charAt(i + 1) === '\n') {
			i++;
		}
	}
	if (is_line_start && text.length > 0) {
		line_offsets.push(text.length);
	}
	return line_offsets;
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
 * @param {string} text The text for which the position should be retrieved
 * @param line_offsets number Array with offsets for each line. Computed if not given
 * @returns {{ line: number, character: number }}
 */
export function position_at(offset, text, line_offsets = get_line_offsets(text)) {
	offset = clamp(offset, 0, text.length);

	let low = 0;
	let high = line_offsets.length;
	if (high === 0) {
		return { line: 0, character: offset };
	}

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const line_offset = line_offsets[mid];

		if (line_offset === offset) {
			return { line: mid, character: 0 };
		} else if (offset > line_offset) {
			low = mid + 1;
		} else {
			high = mid - 1;
		}
	}

	// low is the least x for which the line offset is larger than the current offset
	// or array.length if no line offset is larger than the current offset
	const line = low - 1;
	return { line, character: offset - line_offsets[line] };
}

/**
 *
 * @param {string} svelte2tsx_code
 * @param {string} two_slash_result
 */
function check_removed_lines(svelte2tsx_code, two_slash_result) {
	const svelte2tsx_lines = svelte2tsx_code.split(line_break_regex);
	const two_slash_result_lines = two_slash_result.split(line_break_regex);
	let svelte2tsxIndex = 0;
	/**
	 * @type {Map<number, number>}
	 */
	const generated_to_original = new Map();

	for (let index = 0; index < two_slash_result_lines.length; index++) {
		const twoslash_result_line = two_slash_result_lines[index];

		const correspond_index = svelte2tsx_lines.indexOf(twoslash_result_line, svelte2tsxIndex);

		if (correspond_index < 0) {
			break;
		}

		generated_to_original.set(index, correspond_index);

		svelte2tsxIndex = correspond_index;
	}

	const original_to_generated = new Map(
		Array.from(generated_to_original).map(([generated, original]) => [original, generated])
	);

	return {
		generated_to_original,
		original_to_generated,
		get_removed_lines
	};

	function get_removed_lines() {
		const lines = [];

		for (let index = 0; index < svelte2tsx_lines.length; index++) {
			if (!original_to_generated.has(index)) {
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
function create_source_mapper(rawSourceMap) {
	const consumer = new SourceMapConsumer(rawSourceMap);

	return function map_to_original_position(position) {
		const one_based_position = consumer.originalPositionFor({
			line: position.line + 1,
			column: position.character
		});

		return {
			line: (one_based_position.line ?? 0) - 1,
			character: one_based_position.column ?? 0
		};
	};
}

/**
 *
 * @param {{ original_to_generated: Map<number, number>, generated_to_original: Map<number, number> }} param0
 * @return {{ map_to_generated_position: SourceMapper, map_to_original_position: SourceMapper }}
 */
function create_remove_line_mapper({ original_to_generated, generated_to_original }) {
	return {
		map_to_generated_position(position) {
			const generated_line = original_to_generated.get(position.line);

			return {
				line: generated_line ?? -1,
				character: position.character
			};
		},
		map_to_original_position(position) {
			const line = generated_to_original.get(position.line);

			return {
				line: line ?? -1,
				character: position.character
			};
		}
	};
}

/**
 * @param {string} source
 * @param {number[]} removed_lines
 */
function remove_lines_from_source(source, removed_lines) {
	if (!removed_lines.length) {
		return source;
	}

	const source_lines = source.split(line_break_regex);
	return source_lines.filter((_, index) => !removed_lines.includes(index)).join('\n');
}

/**
 * return patched version of typescript
 * to filter out diagnostics so that ts-twoslash
 * won't throw errors in svelte2tsx generated code
 * @param {string} generated
 * @param {SourceMapper} map_to_original_position
 * @returns {typeof import('typescript')}
 */
function decorate_ts(generated, map_to_original_position) {
	const generated_offset = get_line_offsets(generated);

	return {
		...ts,
		createLanguageService(...args) {
			const ls = ts.createLanguageService(...args);
			const { getSemanticDiagnostics } = ls;

			ls.getSemanticDiagnostics = (filename) => {
				// filter out errors from generated code
				const errors = getSemanticDiagnostics(filename);
				const file = ls.getProgram()?.getSourceFile(filename);
				if (!file) {
					return errors;
				}

				const removed = check_removed_lines(generated, file.getFullText());
				const remove_line_mapper = create_remove_line_mapper(removed);
				const result = errors.filter((e) => {
					const position = position_at(e.start, generated, generated_offset);
					const original_position = map_to_original_position(
						remove_line_mapper.map_to_original_position(position)
					);

					return original_position.line > 0 && original_position.character >= 0;
				});

				return result;
			};

			return ls;
		}
	};
}
