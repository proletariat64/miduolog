// Real Codex extraction of synthetic worksheets only; no child data.
export const questionPage = {
  "pageMarker": "合成数学练习 B · 编号 MIDO-97531 · 题目页",
  "paper": {
    "title": "合成数学练习 B",
    "subject": "数学",
    "grade": "",
    "pageNumber": "",
    "scope": "full_page"
  },
  "materials": [
    {
      "key": "page_note",
      "text": "本页只有题目。学生作答见同编号答题纸。",
      "description": "页面说明；本图未提供答题纸。"
    }
  ],
  "questions": [
    {
      "number": "1",
      "studentAnswer": "",
      "answerStatus": "unclear",
      "teacherReview": {
        "mark": "unmarked",
        "score": "",
        "comment": "",
        "evidence": "本题未见老师批改痕迹。"
      },
      "aiAssessment": {
        "verdict": "uncertain",
        "reason": "9 + 4 = 13，但本图不含学生答题纸，无法判断孩子作答正误。"
      },
      "matchKey": "数学|合成数学练习 B|MIDO-97531|1",
      "sourceLocation": "原图左上方，第1题",
      "bbox": {
        "x": 0.04,
        "y": 0.12,
        "width": 0.27,
        "height": 0.04
      },
      "subject": "数学",
      "question": "计算：9 + 4 =（ ）。",
      "knowledgePoint": "20以内加法",
      "tags": [
        "计算题"
      ],
      "sharedMaterial": "",
      "materialKeys": [
        "page_note"
      ],
      "diagramDescription": "",
      "completeness": "complete",
      "observedError": "",
      "possibleCause": "",
      "needsConfirmation": true,
      "unclear": [
        "孩子原作答及过程未提供，不能据题目页空括号认定未作答。"
      ]
    },
    {
      "number": "2",
      "studentAnswer": "",
      "answerStatus": "unclear",
      "teacherReview": {
        "mark": "unmarked",
        "score": "",
        "comment": "",
        "evidence": "本题未见老师批改痕迹。"
      },
      "aiAssessment": {
        "verdict": "uncertain",
        "reason": "10 - 6 = 4，但本图不含学生答题纸，无法判断孩子作答正误。"
      },
      "matchKey": "数学|合成数学练习 B|MIDO-97531|2",
      "sourceLocation": "原图左上方，第2题，位于第1题下方",
      "bbox": {
        "x": 0.04,
        "y": 0.19,
        "width": 0.28,
        "height": 0.04
      },
      "subject": "数学",
      "question": "计算：10 - 6 =（ ）。",
      "knowledgePoint": "10以内减法",
      "tags": [
        "计算题"
      ],
      "sharedMaterial": "",
      "materialKeys": [
        "page_note"
      ],
      "diagramDescription": "",
      "completeness": "complete",
      "observedError": "",
      "possibleCause": "",
      "needsConfirmation": true,
      "unclear": [
        "孩子原作答及过程未提供，不能据题目页空括号认定未作答。"
      ]
    }
  ],
  "answers": [],
  "unclear": [
    "本页明确为题目页，学生作答见同编号答题纸；该答题纸不在本图中。",
    "图片未标明年级和页码。"
  ]
};

export const answerPage = {
  "pageMarker": "合成数学练习 B · 编号 MIDO-97531 · 答题纸",
  "paper": {
    "title": "合成数学练习 B",
    "subject": "数学",
    "grade": "",
    "pageNumber": "",
    "scope": "full_page"
  },
  "materials": [],
  "questions": [],
  "answers": [
    {
      "number": "1",
      "studentAnswer": "12",
      "answerStatus": "answered",
      "teacherReview": {
        "mark": "incorrect",
        "score": "",
        "comment": "",
        "evidence": "红色文字“老师批改：×”"
      },
      "aiAssessment": {
        "verdict": "uncertain",
        "reason": "本页无题干，无法独立核验答案；老师叉号不作为 AI 判错依据。"
      },
      "matchKey": "合成数学练习 B|MIDO-97531|数学|1",
      "sourceLocation": "原图左上部，第1条学生原作答及其下方老师批改",
      "bbox": {
        "x": 0.04,
        "y": 0.12,
        "width": 0.2,
        "height": 0.11
      }
    },
    {
      "number": "2",
      "studentAnswer": "4",
      "answerStatus": "answered",
      "teacherReview": {
        "mark": "correct",
        "score": "",
        "comment": "",
        "evidence": "红色文字“老师批改：√”"
      },
      "aiAssessment": {
        "verdict": "uncertain",
        "reason": "本页无题干，无法独立核验答案；老师勾号不作为 AI 判断正确的依据。"
      },
      "matchKey": "合成数学练习 B|MIDO-97531|数学|2",
      "sourceLocation": "原图左侧上半部，第2条学生原作答及其下方老师批改",
      "bbox": {
        "x": 0.04,
        "y": 0.265,
        "width": 0.19,
        "height": 0.11
      }
    }
  ],
  "unclear": [
    "页面明确标注“本页无题干。”，两条记录均仅有原答案及老师批改，无法独立判断对错。",
    "未显示年级和页码。"
  ]
};
