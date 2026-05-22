import { Router, type IRouter } from "express";
import healthRouter from "./health";
import lotteryRouter from "./lottery";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lotteryRouter);

export default router;
