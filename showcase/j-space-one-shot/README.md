# J-Space One-shot Showcase

这个目录用于保存通过 DeepSeek Boost Gateway 配合 J-Space Skill，由一句话需求直接生成的单文件网页样例。

当前样例：

- [V4 Pro：霓虹都市 · 城市之夜](city-night-pro-jspace-copilot.html)（29,918 bytes）；
- [V4 Flash：城市夜景 · Three.js](city-night-flash-jspace-copilot.html)（16,439 bytes）。

## 一句话提示词

Pro 与 Flash 使用了同一条原始提示词，未追加页面设计、交互或实现细节：

```text
/j-space 做一个很漂亮的城市夜晚场景。用three.js实现。最终要单网页可以直html，可以直接双击打开
```

这些文件用于展示项目侧实际使用效果，不作为受控 benchmark，也不代表所有提示词、Provider 或 Harness 都会得到相同结果。

文件名记录了模型、J-Space 与生成 Harness：

```text
city-night-pro-jspace-copilot.html
city-night-flash-jspace-copilot.html
```

两份文件均保留上传时的原始生成内容。后续可继续补充 Provider 和必要的运行说明。
