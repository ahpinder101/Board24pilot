import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/requireAuth.js";
import healthRouter from "./health.js";
import storageRouter from "./storage.js";
import manualsRouter from "./manuals.js";
import graphRouter from "./graph.js";
import chatRouter from "./chat.js";
import translateRouter from "./translate.js";
import feedbackRouter from "./feedback.js";

const router: IRouter = Router();

// Health check stays public for deployment probes. Everything below requires
// a valid Clerk session — this gates all data and expensive LLM endpoints.
router.use(healthRouter);
router.use(requireAuth);
router.use(storageRouter);
router.use(manualsRouter);
router.use(graphRouter);
router.use(chatRouter);
router.use(translateRouter);
router.use(feedbackRouter);

export default router;
