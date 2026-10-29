/**
 * 議事録パスからの源泉日(ADR-0026 D3)。実体は @stratum/shared(discord-bot の System One カタログと共用・
 * ADR-0041 D4)。既存の import 先を保つための再 export。
 */
export { minutesDateFromPath } from "@stratum/shared";
