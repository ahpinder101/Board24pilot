import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import storageRouter from "./storage.js";
import manualsRouter from "./manuals.js";
import graphRouter from "./graph.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(storageRouter);
router.use(manualsRouter);
router.use(graphRouter);

export default router;
