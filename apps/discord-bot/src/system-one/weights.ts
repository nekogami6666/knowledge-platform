/**
 * System One の重みと較正パラメータ(ADR-0041 D1 / D7)。値の正は同じディレクトリの weights.json
 * (evals/src/calibrate-system-one.ts が較正して書き出す。commit するのは数値だけで、質問文は入れない)。
 * JSON は zod で検証し、壊れていたら呼び出し側が判定層全体を無効にする(候補ブロック無し)。
 *
 * zod スキーマを kb-core に置かないのは、これが KB のデータ型ではなく bot の設定だから(config.ts と同じ扱い)。
 */
import { z } from "zod";
import rawWeights from "./weights.json" with { type: "json" };

const prob = z.number().min(0).max(1);
const featureWeights = z.record(z.string(), z.number());

/** Platt scaling(p = σ(a·z + b)。z は較正前のロジット)。初期値は恒等(a=1, b=0)。 */
const plattSchema = z.object({ a: z.number(), b: z.number() }).strict();

/** yes/no 判定 1 つ(特徴量の線形和 → ロジスティック → Platt)。 */
const binarySchema = z
  .object({ bias: z.number(), weights: featureWeights, platt: plattSchema })
  .strict();

export const SOURCE_KINDS = ["kb", "minutes", "discord", "code", "none"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const systemOneWeightsSchema = z
  .object({
    /** 重みの版(判定の記録に残す)。 */
    version: z.string().min(1),
    /** 重みの決め方のメモ(人間向け)。 */
    notes: z.array(z.string()).default([]),
    /** 判定全体(語の抽出・候補選定・判定)の時間予算 ms。超えたら「低」(前置き無し)。 */
    budgetMs: z.number().positive(),
    /** カタログ作成を /ask が待つ上限 ms。超えたら今回は前置き無しで、作成は裏で続ける。 */
    buildWaitMs: z.number().positive(),
    retrieval: z
      .object({
        /** 判定に回す候補の上限(語の一致の重みの合計で足切り)。 */
        maxCandidates: z.number().int().positive(),
        /** 候補に残す最小の一致重み(bigram 1 つだけの一致を落とす)。 */
        minHitWeight: z.number().min(0),
      })
      .strict(),
    gate: z
      .object({
        /** p(answerable) がこれ以上なら「高」(抜粋つき)。 */
        high: prob,
        /** p(answerable) がこれ以上なら「中」(一覧のみ)。 */
        mid: prob,
        /** 「高」で出す候補の数(min〜max)。 */
        highMin: z.number().int().positive(),
        highMax: z.number().int().positive(),
        /** 「中」で出す候補の上限。 */
        midMax: z.number().int().positive(),
        /** 「高」で min を超えて載せる候補の関連度の期待値の下限(0〜4)。 */
        minExpected: z.number().min(0).max(4),
      })
      .strict()
      .refine((g) => g.high >= g.mid && g.highMax >= g.highMin, {
        message: "gate は high >= mid かつ highMax >= highMin",
      }),
    /** Score: 候補の関連度(累積ロジットの 5 段階)。thresholds は昇順の 4 つ。 */
    relevance: z
      .object({
        bias: z.number(),
        weights: featureWeights,
        thresholds: z
          .array(z.number())
          .length(4)
          .refine((t) => t.every((v, i) => i === 0 || (t[i - 1] ?? v) < v), {
            message: "thresholds は狭義の昇順",
          }),
        platt: plattSchema,
      })
      .strict(),
    timeSensitive: binarySchema,
    needsCode: binarySchema,
    answerable: binarySchema,
    /** Choice: primarySource(softmax・温度で較正)。 */
    primarySource: z
      .object({
        weights: z
          .object({
            kb: featureWeights,
            minutes: featureWeights,
            discord: featureWeights,
            code: featureWeights,
            none: featureWeights,
          })
          .strict(),
        temperature: z.number().positive(),
      })
      .strict(),
  })
  .strict();

export type SystemOneWeights = z.infer<typeof systemOneWeightsSchema>;
export type BinaryWeights = z.infer<typeof binarySchema>;

/** 任意の値を重みとして検証する(較正スクリプトの出力の検証にも使う)。 */
export function parseSystemOneWeights(raw: unknown): SystemOneWeights {
  return systemOneWeightsSchema.parse(raw);
}

/** commit 済みの weights.json を検証して返す(壊れていれば throw — 呼び出し側が機能を無効にする)。 */
export function loadDefaultWeights(): SystemOneWeights {
  return parseSystemOneWeights(rawWeights);
}
