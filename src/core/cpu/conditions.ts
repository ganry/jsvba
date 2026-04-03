import type { RegisterFile } from './registers.js';

export type ConditionChecker = (rf: RegisterFile) => boolean;

/**
 * ARM condition code evaluators.
 * Bits [31:28] of every ARM instruction encode a condition.
 * 16-entry LUT indexed by condition code.
 */
export const conditionTable: ConditionChecker[] = [
  /* 0x0 EQ */ (rf) => rf.flagZ,
  /* 0x1 NE */ (rf) => !rf.flagZ,
  /* 0x2 CS/HS */ (rf) => rf.flagC,
  /* 0x3 CC/LO */ (rf) => !rf.flagC,
  /* 0x4 MI */ (rf) => rf.flagN,
  /* 0x5 PL */ (rf) => !rf.flagN,
  /* 0x6 VS */ (rf) => rf.flagV,
  /* 0x7 VC */ (rf) => !rf.flagV,
  /* 0x8 HI */ (rf) => rf.flagC && !rf.flagZ,
  /* 0x9 LS */ (rf) => !rf.flagC || rf.flagZ,
  /* 0xA GE */ (rf) => rf.flagN === rf.flagV,
  /* 0xB LT */ (rf) => rf.flagN !== rf.flagV,
  /* 0xC GT */ (rf) => !rf.flagZ && (rf.flagN === rf.flagV),
  /* 0xD LE */ (rf) => rf.flagZ || (rf.flagN !== rf.flagV),
  /* 0xE AL */ () => true,
  /* 0xF NV */ () => true, // Unconditional in ARMv5+, undefined in ARMv4 (treat as AL)
];
