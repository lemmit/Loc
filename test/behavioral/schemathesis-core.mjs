// Shared core for the schemathesis contract-fuzzing legs (M-T9.21).
//
// CLAIMED / IN PROGRESS — this module is being extracted from
// run-schemathesis.mjs so all five backends can share one fuzz loop, one
// finding parser and one ratcheting waiver register, with only the BOOT
// recipe differing per backend.
