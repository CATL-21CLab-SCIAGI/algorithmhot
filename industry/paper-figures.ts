/** Reviewed original figures for the pilot, bound to the exact source revision.
 * URLs refer to publisher/author-hosted originals, never generated illustrations.
 * sha256 records bytes at review time; remote hosting is not an immutable archive.
 */
export interface PaperFigure {
  itemId: string;
  sourceRevision: number;
  imageOrigin: "remote" | "pdf-extract";
  imageUrl: string;
  sourceUrl: string;
  figureLabel: string;
  caption: string;
  attribution: string;
  licenseName: string;
  licenseUrl: string;
  verifiedAt: string;
  width: number;
  height: number;
  contentType: string;
  sha256: string;
}

export const PAPER_FIGURES: readonly PaperFigure[] = [
  {
    "itemId": "s8moemck93yrl4cn1on69rv4s",
    "sourceRevision": 1,
    "imageUrl": "/paper-figures/dmad-v1-figure3.png",
    "sourceUrl": "https://arxiv.org/pdf/2610.02188v1#page=5",
    "figureLabel": "原文图 3 · DMAD 方法总览",
    "caption": "教师、真实与学生样本经共享骨干送入两个判别头；判别器的线性损失训练学生，真实数据分支的差距用于调整教师权重。取自 PDF 第 5 页，保留完整图区，未重绘。",
    "attribution": "Zhengming Yu 等，DMAD（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "width": 1459,
    "height": 482,
    "contentType": "image/png",
    "imageOrigin": "pdf-extract",
    "verifiedAt": "2026-10-04T06:37:20.424Z",
    "sha256": "14e167f8a42884986908c414b4625c2f3f52e393a3740f2c3e12725a7775d20d"
  },
  {
    "itemId": "xukjz8mfnifv1c57mwybn5o11",
    "sourceRevision": 1,
    "imageUrl": "https://arxiv.org/html/2610.02199v1/hk_then_selector_cleanlabels.svg",
    "sourceUrl": "https://arxiv.org/html/2610.02199v1#S5.F2",
    "figureLabel": "原文图 2 · 右侧稀疏选择示意",
    "caption": "图中以每列保留两个较大梯度分量为例，再取绝对值最大项的符号形成更新；这是原图的右侧图块，论文实验每列保留 16 项。",
    "attribution": "Jichao Jiang 等，TACO（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "width": 394,
    "height": 172,
    "contentType": "image/svg+xml",
    "imageOrigin": "remote",
    "verifiedAt": "2026-10-04T06:37:20.428Z",
    "sha256": "3e67c0b76cac8b45b1b9da0a0aeefbe58f153cba30e4e58865a170497423b119"
  },
  {
    "itemId": "rmujtpniv4b0wgn8q2tustjac",
    "sourceRevision": 1,
    "imageUrl": "https://arxiv.org/html/2610.02195v1/solver_scaling.svg",
    "sourceUrl": "https://arxiv.org/html/2610.02195v1#S3.F1",
    "figureLabel": "原文图 1 · 求解器规模实验",
    "caption": "作者在不同规模道路网络上比较内存、每轮计算时间和拟合迭代次数，展示精确桥求解器的规模变化；具体网络和条件见原图注。",
    "attribution": "Akshay Balsubramani（arXiv v1）",
    "licenseName": "arXiv 发布许可 · 作者保留版权",
    "licenseUrl": "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "width": 476,
    "height": 170,
    "contentType": "image/svg+xml",
    "imageOrigin": "remote",
    "verifiedAt": "2026-10-04T06:37:20.432Z",
    "sha256": "844285f2c442b43e47e851c086e237ec8257db2e89c6422a532e2028e34ca88e"
  },
  {
    "itemId": "n7gty26hkso9o0egz436qszwh",
    "sourceRevision": 1,
    "imageUrl": "https://arxiv.org/html/2610.02185v1/html-figures/rvArchCompact.png",
    "sourceUrl": "https://arxiv.org/html/2610.02185v1#S3.F3",
    "figureLabel": "原文图 3 · LoopCD 的两种对比位置",
    "caption": "Hidden 形式先组合早期与最终隐藏状态，再通过输出层；Logits 形式分别经过输出层后组合预测，两者的输出层计算次数不同。",
    "attribution": "Weihao Liu 等，LoopCD（arXiv v1）",
    "licenseName": "arXiv 发布许可 · 作者保留版权",
    "licenseUrl": "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "width": 1890,
    "height": 408,
    "contentType": "image/png",
    "imageOrigin": "remote",
    "verifiedAt": "2026-10-04T06:37:20.435Z",
    "sha256": "f47fc6219d446c41bc51d1612c8985871227fd13a58421d70e18da567c0e654f"
  },
  {
    "itemId": "cgogkeh2te0qeshodfgr85gix",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02204v1/pipeline-0930.png",
    "sourceUrl": "https://arxiv.org/html/2610.02204v1#S1.F2",
    "figureLabel": "原文图 2 · 方法总览",
    "caption": "RPG 原文方法图：执行与视频分析支持技能改进，候选修订经跨任务评估后合并和保留。",
    "attribution": "Yen-Jen Wang 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:37.139Z",
    "width": 2038,
    "height": 906,
    "contentType": "image/png",
    "sha256": "8a9baa68cfe276364d98bd93704e7a0053c669732aa440317e2aaab492fd2686"
  },
  {
    "itemId": "i1kt74wkfu1sylbqhmi2t7dnv",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02206v1/pipe.png",
    "sourceUrl": "https://arxiv.org/html/2610.02206v1#S2.F2",
    "figureLabel": "原文图 2 · 方法总览",
    "caption": "KaliBench 原文流程：自然语言到命令的基准构建、验证与细粒度评测。",
    "attribution": "Pengfei Li 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:39.937Z",
    "width": 1384,
    "height": 630,
    "contentType": "image/png",
    "sha256": "9551f41701b8137a066d065dc0b199cd3e5525b52182f341f4bad842a0374c41"
  },
  {
    "itemId": "snmbmzrubqis2mvxth8qidlnb",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02202v1/fig03_construction.png",
    "sourceUrl": "https://arxiv.org/html/2610.02202v1#S3.F3",
    "figureLabel": "原文图 3 · 方法总览",
    "caption": "ScholarCatalyst 原文构建流程：自动准备候选文献，再由项目作者评审问题、相关性及理由。",
    "attribution": "Sohyeon Kim 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:43.015Z",
    "width": 1280,
    "height": 417,
    "contentType": "image/png",
    "sha256": "ce372887a777517af719472d428f1323907b805e3a16ff1846e50fdc89e90608"
  },
  {
    "itemId": "k92n912um78c2hvdqmmadyq15",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02200v1/fig_designs.png",
    "sourceUrl": "https://arxiv.org/html/2610.02200v1#S3.F3",
    "figureLabel": "原文图 3 · 方法总览",
    "caption": "VISTA 原文方法图：视觉观察、无损视觉记忆和模型自主检索构成交互推理框架。",
    "attribution": "Qiushi Han 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:46.035Z",
    "width": 785,
    "height": 445,
    "contentType": "image/png",
    "sha256": "e5e82af2b0efb957b8fdc621ca4f50f4360eca7635289b5711e96d76038e6818"
  },
  {
    "itemId": "mv9x419gecxc33463mbm3c73x",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02150v1/framework.png",
    "sourceUrl": "https://arxiv.org/html/2610.02150v1#S4.F2",
    "figureLabel": "原文图 2 · 方法总览",
    "caption": "SourceLearn 原文框架：来源模型初始化、自主学习、任务引导学习与推理时激活。",
    "attribution": "Lucheng Fu 等（arXiv v1）",
    "licenseName": "CC BY SA 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by-sa/4.0/",
    "verifiedAt": "2026-10-04T06:34:49.288Z",
    "width": 1404,
    "height": 840,
    "contentType": "image/png",
    "sha256": "ec3e6d5306dd4e0d302b2eee47892c92956264d14880399f444673d843ceb9c2"
  },
  {
    "itemId": "ikrv23aya4o9io6bh7il8k4dt",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.02186v1/HGR-frame1d.png",
    "sourceUrl": "https://arxiv.org/html/2610.02186v1#Sx2.F1",
    "figureLabel": "原文图 1 · 方法总览",
    "caption": "HGR 原文总览：分子高阶拓扑通过语法转成规则序列，并用于重构和学习。",
    "attribution": "Yiming Huang 等（arXiv v1）",
    "licenseName": "arXiv 发布许可 · 作者保留版权",
    "licenseUrl": "https://arxiv.org/licenses/nonexclusive-distrib/1.0/",
    "verifiedAt": "2026-10-04T06:34:52.446Z",
    "width": 968,
    "height": 826,
    "contentType": "image/png",
    "sha256": "94f522d4651f0085ad83456d3f8703bb91bfcd3c1bd33c7a76cb4b5f4bd23f1a"
  },
  {
    "itemId": "wxw0bszppi6uq0njkt976pjzl",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.01898v1/fig1.png",
    "sourceUrl": "https://arxiv.org/html/2610.01898v1#S4.F1",
    "figureLabel": "原文图 1 · 方法总览",
    "caption": "GEODE 原文总览：对称性模板与扩散模型联合生成晶格、坐标和原子类型。",
    "attribution": "Yuchen Lou 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:55.395Z",
    "width": 660,
    "height": 420,
    "contentType": "image/png",
    "sha256": "1fee00245c0e996b053abe8555b2c6c44a69a19a9abe3ed4acba8c774a164393"
  },
  {
    "itemId": "ywwig016167ebi1oemd78uwwz",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.00602v1/Figure2.png",
    "sourceUrl": "https://arxiv.org/html/2610.00602v1#S2.F2",
    "figureLabel": "原文图 2 · 方法总览",
    "caption": "CPathOGen 原文架构：空间条件与形态、染色条件分别调控 H&E 组织图像生成。",
    "attribution": "Samarth Singhal 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:34:58.670Z",
    "width": 1800,
    "height": 600,
    "contentType": "image/png",
    "sha256": "b5f0b0b8a406fa858210caa658c69a11146c0bc4536bb85c6df4ac1e04054529"
  },
  {
    "itemId": "laxi0tw3qvkt5aixacj0k0bge",
    "sourceRevision": 1,
    "imageOrigin": "remote",
    "imageUrl": "https://arxiv.org/html/2610.01891v1/models-v2.png",
    "sourceUrl": "https://arxiv.org/html/2610.01891v1#S2.F2",
    "figureLabel": "原文图 2 · 方法总览",
    "caption": "RipplePLM 原文架构：直接与远端结构线索、属性监督共同组织突变效应描述。",
    "attribution": "Liuzhenghao Lv 等（arXiv v1）",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:35:01.775Z",
    "width": 2041,
    "height": 1550,
    "contentType": "image/png",
    "sha256": "66068c4b3304950d82277bf18fa020d2aa68c036bf8649ff6ec578e25399ba94"
  },
  {
    "itemId": "dpg8u2s8yta9nmfjmnc77dr98",
    "sourceRevision": 2,
    "imageOrigin": "remote",
    "imageUrl": "https://media.springernature.com/full/springer-static/image/art%3A10.1038%2Fs41586-026-10965-y/MediaObjects/41586_2026_10965_Fig1_HTML.png",
    "sourceUrl": "https://www.nature.com/articles/s41586-026-10965-y/figures/1",
    "figureLabel": "原文图 1 · 方法总览",
    "caption": "SynthIDBio 原文方法总图：序列采样水印与结构模型微调水印两条分支，以及各自的检测过程。",
    "attribution": "David Stutz 等，Nature（2026），SynthID Bio 原始研究",
    "licenseName": "CC BY 4.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
    "verifiedAt": "2026-10-04T06:35:03.299Z",
    "width": 1761,
    "height": 938,
    "contentType": "image/png",
    "sha256": "bfb9ab1f79a0972011ccb4fe70ccbd06b8615a8166aa31f26bf9dd1e3e90b75f"
  }
];

/** Absence statements require a checked original, not an unreachable response. */
export const PAPER_FIGURE_NOTES: Readonly<Record<string, { sourceRevision: number; sourceUrl: string; note: string }>> = {
  "iqoqm9ozj8ccym2r15iaof8f5": {
    "sourceRevision": 1,
    "sourceUrl": "https://arxiv.org/pdf/2610.02158v1",
    "note": "原文 v1 无图示：已核对 HTML 与 26 页 PDF。本文以理论推导为主，可直接阅读原文。"
  }
};
