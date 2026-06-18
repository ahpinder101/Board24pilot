import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import storageRouter from "./storage.js";
import manualsRouter from "./manuals.js";
import graphRouter from "./graph.js";
import chatRouter from "./chat.js";
import translateRouter from "./translate.js";
import feedbackRouter from "./feedback.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(manualsRouter);
router.use(graphRouter);
router.use(chatRouter);
router.use(translateRouter);
router.use(feedbackRouter);

export default router;
