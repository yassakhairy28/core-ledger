import { Router } from "express";
import Joi from "joi";
import { LedgerController } from "../controllers/ledger.controller.js";
import { validate } from "../middlewares/validation.middleware.js";

const router = Router();
const controller = new LedgerController();

const openAccountSchema = {
  body: Joi.object({
    account_id: Joi.string().trim().required(),
    account_type: Joi.string()
      .valid("customer", "system", "liability")
      .required(),
  }),
};

const transferSchema = {
  body: Joi.object({
    from_account_id: Joi.string().trim().required(),
    to_account_id: Joi.string().trim().required(),
    amount: Joi.number().integer().positive().required(),
  }),
};

const placeHoldSchema = {
  body: Joi.object({
    account_id: Joi.string().trim().required(),
    hold_id: Joi.string().trim().required(),
    amount: Joi.number().integer().positive().required(),
  }),
};

const captureVoidHoldSchema = {
  body: Joi.object({
    account_id: Joi.string().trim().required(),
  }),
};

router.post(
  "/accounts",
  validate(openAccountSchema),
  controller.open_account.bind(controller),
);

router.post(
  "/transfers",
  validate(transferSchema),
  controller.transfer.bind(controller),
);

router.post(
  "/holds",
  validate(placeHoldSchema),
  controller.place_hold.bind(controller),
);
router.post(
  "/holds/:id/capture",
  validate(captureVoidHoldSchema),
  controller.capture_hold.bind(controller),
);
router.post(
  "/holds/:id/void",
  validate(captureVoidHoldSchema),
  controller.void_hold.bind(controller),
);

router.get("/accounts/:id/balance", controller.get_balance.bind(controller));
router.get("/accounts/:id/statement", controller.get_statement.bind(controller));

router.get(
  "/verification/invariants",
  controller.verify_invariants.bind(controller),
);

export default router;
