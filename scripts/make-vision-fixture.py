"""生成代码绘制的测试作业，不含真实学生数据。"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
out = Path(__file__).resolve().parents[1] / '.scratch/mistake-notebook/verification'
out.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (1400, 960), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 37)
title = ImageFont.truetype('C:/Windows/Fonts/msyh.ttc', 44)
math_font = ImageFont.truetype('C:/Windows/Fonts/cambria.ttc', 46)
def text(x, y, value, use_font=font):
    draw.text((x, y), value, font=use_font, fill='black')
def fraction(x, y, numerator, denominator):
    text(x+14, y, numerator, math_font)
    draw.line((x, y+57, x+58, y+57), fill='black', width=2)
    text(x+14, y+60, denominator, math_font)
text(65, 40, '图片识别验证 · 示例作业', title)
text(65, 125, '页面标记：松树 42719')
text(65, 235, '1. 数学：计算下面的分数除法。')
fraction(110, 310, '5', '6')
text(195, 347, '÷', math_font)
fraction(285, 310, '2', '3')
text(65, 485, '学生作答：')
fraction(320, 450, '5', '6')
text(405, 487, '×', math_font)
fraction(495, 450, '2', '3')
text(585, 487, '=', math_font)
fraction(675, 450, '5', '9')
text(65, 650, '2. 语文：修改病句。')
text(65, 720, '通过这次活动，使我明白了合作的重要性。')
text(65, 800, '学生作答：原句正确，不需要修改。')
image.save(out / 'vision-fixture.png')
print(out / 'vision-fixture.png')
