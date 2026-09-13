// pi-loop 核心检索引擎（M5-T2）——相似方法/案例的纯函数评分与 top-k 截取
// 依据 docs/plans/m5-archivist.md Task 2、docs/SPEC.md §4（Designer 检索注入的输入面）。
//
// 相似度设计（中文友好、零依赖、零分词器）：
//   特征 = CJK 二元组（相邻表意字符对）+ ASCII 词 token（\w+，小写归一）。
//   中文无空格分词——2-gram 是无词典条件下最稳的子串匹配单元（整句几乎不重合、
//   单字又高歧义）；英文天然空格分界，词级 token 才正（2-gram 会把 "loop" 拆碎）。
//
// 评分公式（与 .superpowers/sdd/m5-archivist/task-2-report.md 同口径）：
//   方法分 = 适用面命中率 × fitness 证据乘数
//     命中率 = 方法的 taskTypes+signals 特征被任务特征覆盖的比例（召回口径）
//     证据乘数 = 1 + uses/(uses+2) × avgScore/100（区间 [1,2)——新方法不埋没也不霸榜）
//   案例分 = 任务相似度（Dice 系数）+ verified × 0.1（相似但未验收也不为零——
//     失败案例同样有参考价值）
// 入选门槛：分 > 0；案例另要求相似度 > 0（verified 加成不单独构成入选资格
// ——不相关的已验收旧案例不注入）。方法列/案例列各自取 top-k（k 缺省 3；k≤0 双空）。
// 纯函数零 IO：调用方喂 listMethods/listCases 的结果——本模块不读磁盘、不查时间、
// 不改动入参数组（排序在映射副本上进行）。

import type { Case, MethodologyEntry } from "../types.ts";

/** 每列默认保留条数（方法与案例各自 top-k，缺省值） */
const DEFAULT_K = 3;

/** 检索结果：方法/案例两列各自的 top-k（空库或零命中 → 双空数组——调用方据此省略注入） */
export interface RetrievalResult {
	/** 相似方法（分值降序；分值并列保持入参序） */
	methods: MethodologyEntry[];
	/** 相似案例（分值降序；分值并列保持入参序） */
	cases: Case[];
}

/** retrieve 的入参（库内容由调用方持有——检索不做任何 IO） */
export interface RetrieveOptions {
	methods: MethodologyEntry[];
	cases: Case[];
	/** 每列保留的最大条数（缺省 3；≤0 视为明确不检索 → 直接返回双空数组） */
	k?: number;
}

/** CJK 表意字符判定（基本区＋扩展A——覆盖常用汉字的极简范围，不做全 Unicode 区段收全） */
const CJK_CHAR_RE = /[\u3400-\u4DBF\u4E00-\u9FFF]/;

/** ASCII 词 token（g 标志是 matchAll 的要求；matchAll 迭代不改动共享正则的 lastIndex） */
const ASCII_WORD_RE = /\w+/g;

/**
 * 文本特征集：CJK 2-gram + ASCII 词 token（小写归一）。
 * 孤立单字不成特征（中文特征最小单元是二元组——单字特征高歧义噪声大）；跨 CJK
 * 边界（标点/字母/数字/空格）不成组——特征永远是「连续表意字符对」。
 */
function extractFeatures(text: string): Set<string> {
	const features = new Set<string>();
	let previous = "";
	for (const ch of text) {
		if (CJK_CHAR_RE.test(ch)) {
			if (previous !== "") features.add(previous + ch);
			previous = ch;
		} else {
			previous = "";
		}
	}
	for (const token of text.toLowerCase().matchAll(ASCII_WORD_RE)) {
		features.add(token[0]);
	}
	return features;
}

/**
 * 命中度：候选特征出现在查询特征里的比例——「方法声明的适用面被任务覆盖了多少」
 * 的召回口径。候选特征为空（无声明）→ 0：没有适用面主张就没有检索依据。
 * 选命中率（归一命中计数）而非 Jaccard 的理由：Jaccard 分母含任务特征全集，
 * 任务文本越长全体候选分数同被稀释（分数随查询长度漂移、无跨查询可比性）；
 * 未归一的裸命中计数则激励「信号列表越长中得越多」——归一让分数只取决于
 * 声明信号的命中比例。
 */
function containment(candidate: Set<string>, query: Set<string>): number {
	if (candidate.size === 0) return 0;
	let hits = 0;
	for (const feature of candidate) {
		if (query.has(feature)) hits++;
	}
	return hits / candidate.size;
}

/** Dice 系数：两特征集的对称相似度 2|A∩B|/(|A|+|B|)（0-1）——文本对文本的镜像口径 */
function dice(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
	let hits = 0;
	for (const feature of smaller) {
		if (larger.has(feature)) hits++;
	}
	return (2 * hits) / (a.size + b.size);
}

/** 字符串数组的防御读取（listMethods 不做深校验——磁盘 JSON 缺形时按空处理，不抛） */
function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

/** 非负有限数字（防御：缺形/NaN/负数一律按 0——统计缺失按「无证据」处理） */
function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/**
 * 方法分：适用面命中率 × fitness 证据乘数。
 * 乘数恒 ≥ 1 且 < 2：零实证（新方法，uses=0）不折损信号分（不埋没）；实证
 * 越足上浮越多但有封顶（uses=2 已半权、百次仍只 0.98——不霸榜）——微弱实证
 * 的老方法可压过同信号面的新方法，信号面明显更优的新方法保持第一。
 */
function methodScore(
	method: MethodologyEntry,
	taskFeatures: Set<string>,
): number {
	// taskTypes＋signals 拼接评估；空格分隔防跨条目伪 2-gram
	//（"研究"+"评估" 直拼会伪造 "究评"，偷命中含该 bigram 的任务）
	const appliesText = [
		...stringArray(method.appliesTo?.taskTypes),
		...stringArray(method.appliesTo?.signals),
	].join(" ");
	const match = containment(extractFeatures(appliesText), taskFeatures);
	if (match <= 0) return 0;
	const uses = nonNegativeNumber(method.fitness?.uses);
	const avgScore = Math.min(nonNegativeNumber(method.fitness?.avgScore), 100);
	return match * (1 + (uses / (uses + 2)) * (avgScore / 100));
}

/**
 * 案例分 = 任务相似度（Dice）+ verified 加成（×0.1；相似但未验收也非零——
 * 失败案例同样有参考价值）。相似度 > 0 为入选门槛——加成不单独构成资格
 * （已验收但零相关的旧案例不注入，防参考段被噪声占据）
 */
function caseScore(entry: Case, taskFeatures: Set<string>): number {
	const task = typeof entry.task === "string" ? entry.task : "";
	const similarity = dice(taskFeatures, extractFeatures(task));
	if (similarity <= 0) return 0;
	return similarity + (entry.verified === true ? 0.1 : 0);
}

/**
 * 相似检索（M5-T2 主入口，供 T3 接线在 generatePlan 之前调用）。
 * 对方法库与案例档案按任务文本评分，两列各自取 top-k。
 * 确定性：分值降序、并列分值保持入参序（方法=listMethods 的 id 字典序、案例=
 * listCases 的 createdAt 倒序）——任意平台同输入必同输出。
 */
export function retrieve(task: string, opts: RetrieveOptions): RetrievalResult {
	const k = opts.k ?? DEFAULT_K;
	if (k <= 0) return { methods: [], cases: [] };
	const taskFeatures = extractFeatures(task);
	// 单列排序管线：通过（分>0）→ 降序（并列保入参序）→ 截断
	const rank = <T>(items: T[], score: (item: T) => number): T[] =>
		items
			.map((item, index) => ({ item, index, value: score(item) }))
			.filter((row) => row.value > 0)
			.sort((a, b) => b.value - a.value || a.index - b.index)
			.slice(0, k)
			.map((row) => row.item);
	return {
		methods: rank(opts.methods, (method) => methodScore(method, taskFeatures)),
		cases: rank(opts.cases, (c) => caseScore(c, taskFeatures)),
	};
}
