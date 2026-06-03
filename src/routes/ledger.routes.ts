import { Router } from "express";
import { LedgerController } from "../controllers/ledger.controller.js";

const router = Router();
const controller = new LedgerController();

// حجز وفتح الحسابات
router.post("/accounts", controller.open_account.bind(controller));

// التحويلات المالية (Double-entry)
router.post("/transfers", controller.transfer.bind(controller));

// إدارة الـ Holds (Two-phase actions)
router.post("/holds", controller.place_hold.bind(controller));
router.post("/holds/:id/capture", controller.capture_hold.bind(controller));
router.post("/holds/:id/void", controller.void_hold.bind(controller));

router.get("/accounts/:id/balance", controller.get_balance.bind(controller));

router.get(
  "/verification/invariants",
  controller.verify_invariants.bind(controller),
);

export default router;
