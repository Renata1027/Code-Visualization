# 代码执行演变可视化 (Code Line Evolution Visualizer)

粘贴一段 JavaScript 代码，逐步查看它运行时**每一行**、**每个变量**是如何变化的 —— 帮助你理解代码的实际执行过程。

## 使用方法

直接用浏览器打开 `index.html` 即可使用（无需安装任何依赖、无需联网，也不需要构建步骤）。

也可以用任意静态文件服务器打开，例如：

```bash
python3 -m http.server 8080
# 然后浏览器访问 http://localhost:8080
```

## 功能

- 粘贴或选择示例 JavaScript 代码，点击「运行并可视化」
- 单步前进/后退、播放/暂停（可调速度）、进度条拖拽跳转
- 当前执行行会在编辑器中高亮，并显示这一步做了什么
- 右侧面板实时展示：
  - **调用栈 & 变量**：当前每一层函数调用的局部变量，发生变化的变量会高亮显示
  - **执行时间线**：所有已执行步骤的列表，可点击跳转到任意一步
  - **控制台输出**：`console.log` 的输出内容
- 编辑器行号旁显示每一行的「执行热度」（该行被执行了多少次），直观呈现循环/递归的热点

## 支持的 JavaScript 语法

变量声明 (`let`/`const`/`var`)、赋值与复合赋值、`if/else`、`for`/`while`/`do-while`/`for-of`/`for-in`、
函数声明与箭头函数（含递归、闭包、默认参数、剩余参数）、数组与对象字面量、解构赋值、模板字符串、
`try/catch/finally`/`throw`、`switch`、常用内置对象（`Math`、`JSON`、`Array`、`Object`、`Map`、`Set`、`Date` 等）。

暂不支持：`class`、`this`、`async/await`、生成器函数、模块 `import/export`。

## 工作原理

所有代码的解析（使用内置的 [Acorn](https://github.com/acornjs/acorn) 解析器，见 `vendor/acorn.js`）与执行
（`js/interpreter.js` 中实现的一个小型 JavaScript 解释器）都在浏览器本地完成。解释器在执行每一条语句时都会
记录下一份「步骤快照」（当前行、调用栈、每个变量的值、发生了哪些变化），运行完成后 `js/app.js` 负责把这些
步骤渲染成可以单步查看/播放的交互界面。代码不会上传到任何服务器。

## 目录结构

```
index.html          页面结构
css/style.css        样式（支持浅色/深色主题、移动端适配）
js/interpreter.js    小型 JS 解释器：解析代码并生成逐行执行的步骤快照
js/app.js            界面逻辑：编辑器、播放控制、变量/时间线/控制台渲染
js/examples.js        内置示例代码
vendor/acorn.js       第三方 JS 解析器 Acorn（本地内置，无需联网）
```
