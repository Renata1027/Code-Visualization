# 代码执行演变可视化 (Code Line Evolution Visualizer)

粘贴一段 JavaScript、Python 或 Java 代码，逐步查看它运行时**每一行**、**每个变量**是如何变化的 —— 帮助你理解代码的实际执行过程。数组、链表、二叉树、哈希表等常见数据结构会被自动识别并画成图形（方框、箭头、树状连线），而不是一段不好读的文本。支持 LeetCode 风格的测试用例：自动识别代码里的方法，只需像 LeetCode 一样填参数（如 `[1,2,3]`），不用自己拼调用表达式；也可以像 LeetCode 一样管理多个测试用例。

## 使用方法

`index.html` 是一个**完全自包含**的单文件页面（CSS、三套解释器全部内联），直接用浏览器打开即可使用，不依赖任何同级文件——即使把这一个文件单独拷走也能正常运行。JavaScript 和 Java 模式完全离线可用；Python 模式首次运行需要联网，从 CDN 下载浏览器内 Python 运行环境（[Pyodide](https://pyodide.org/)，几 MB，只需下载一次）。

也可以用任意静态文件服务器打开：

```bash
python3 -m http.server 8080
# 然后浏览器访问 http://localhost:8080
```

## 功能

- **三语言支持**：JavaScript（内置小型解释器）、Python（基于浏览器内真实 CPython 执行 + 逐行追踪，几乎支持所有常见语法，包括 `class`）、Java（内置的 Java 语法子集解释器，支持 class/继承/常用集合）
- **变量图形化可视化**：不再只是打印一段文本，而是按结构画出来——数组渲染成带下标的方框；链表（有 `next` 字段的对象链）渲染成一串用箭头连接的方框，并标出 `null`/环；二叉树（有 `left`/`right` 字段的对象）渲染成真正的树状图，带连接线；`Map`/`Set` 也各自有对应的图形，普通对象展示字段列表
- **方法自动识别，参数式调用（LeetCode 风格）**：粘贴代码后会自动扫描出可调用的类方法/函数，下拉选择后只需填参数（如 `[1, 2, 3]`），不用自己写 `Solution().subsets([1, 2, 3])` 这样的完整调用表达式；也保留「自定义表达式」选项供手写复杂调用
- **多测试用例（LeetCode 风格）**：像 LeetCode 一样管理多个「用例」标签页；点「运行」会一次性跑完所有用例，在「测试结果」里看到每个用例的输出，点某一行还能跳过去单步调试那个用例
- **布局**：代码编辑区和变量可视化区左右并排放置，播放控制条固定在两者下方贯穿全宽——点「运行」/单步/暂停的地方和看结果的地方在同一屏，不用来回找
- 粘贴或选择示例代码，点击「运行并可视化」
- 单步前进/后退、播放/暂停（可调速度）、进度条拖拽跳转
- 当前执行行会在编辑器中高亮，并显示这一步做了什么
- 变量可视化面板实时展示：
  - **调用栈 & 变量**：当前每一层函数调用的局部变量（含图形化展示），发生变化的变量会高亮显示
  - **执行时间线**：所有已执行步骤的列表，可点击跳转到任意一步
  - **控制台输出**：`console.log` / `print` 的输出内容
- 编辑器行号旁显示每一行的「执行热度」（该行被执行了多少次），直观呈现循环/递归的热点

## 支持的语法

**JavaScript**：变量声明 (`let`/`const`/`var`)、赋值与复合赋值、`if/else`、`for`/`while`/`do-while`/`for-of`/`for-in`、
函数声明与箭头函数（含递归、闭包、默认参数、剩余参数）、数组与对象字面量、解构赋值、模板字符串、
`try/catch/finally`/`throw`、`switch`、常用内置对象（`Math`、`JSON`、`Array`、`Object`、`Map`、`Set`、`Date` 等）。
支持构造函数模式的 `this`（如 `function ListNode(val, next) { this.val = val; ... }`，LeetCode 常见写法）。
不支持：`class` 关键字、`async/await`、生成器函数、模块 `import/export`。

**Python**：基于真实 CPython 解释执行（通过 `sys.settrace` 逐行追踪），因此支持绝大多数标准语法，包括 `class`、
装饰器、推导式、`try/except/finally`、上下文管理器等。不支持：`async`/`await`、多线程/多进程、访问本机文件系统或网络
（Pyodide 沙箱本身的限制）。

**Java**：内置的 Java 语法子集解释器（自己写的树遍历解释器，不是真的 JVM），支持 `class`（含继承、静态成员、嵌套类）、
`if/for/while/do-while/switch/try-catch-finally/throw`、数组（含多维）、常用集合
（`ArrayList`/`LinkedList`/`HashMap`/`TreeMap`/`HashSet`/`TreeSet`/`Stack`/`PriorityQueue`/`StringBuilder`）、
`Math`/`Integer`/`Character`/`Arrays`/`Collections` 等常用静态方法、`int` 溢出与截断除法等数值语义、基础 lambda
表达式（用于 `sort`/`forEach` 的比较器）、内置 `ListNode`/`TreeNode`（未在代码里定义时自动提供，和 LeetCode 一致）。
不支持：泛型的编译期检查（运行期按原始类型处理）、接口/抽象类、反射、多线程、注解处理、方法引用 `::`、
`switch` 表达式（新语法）、`record`/`sealed` 等较新特性。

## 工作原理

- **JavaScript**：使用内置的 [Acorn](https://github.com/acornjs/acorn) 解析器解析代码，再用 `js/interpreter.js` 中实现的
  一个小型树遍历解释器逐语句执行；每执行完一条语句就记录一份「步骤快照」（当前行、调用栈、每个变量的值、发生了哪些变化）。
- **Python**：通过 [Pyodide](https://pyodide.org/)（编译到 WebAssembly 的 CPython）在浏览器里真实运行你的代码，
  用 `sys.settrace` 在每一行/每次函数调用与返回时记录同样格式的「步骤快照」（追踪器源码见 `python/tracer.py`，
  `build.js` 会把它作为字符串注入页面，运行时喂给 Pyodide 执行）。
- **Java**：用 [java-parser](https://github.com/jhipster/prettier-java/tree/main/packages/java-parser)（`vendor/java-parser.js`，
  基于 Chevrotain 的完整 Java 语法解析器）把代码解析成语法树，再用 `js/java_interpreter.js` 中实现的树遍历解释器
  逐语句执行，记录同样格式的「步骤快照」；数值运算实现了 Java 的整型截断除法、`int` 32 位溢出等语义，并在
  开发过程中用真实的 `javac`/`java` 交叉验证过（递归、回溯、集合、异常、整数溢出等场景的输出逐字节比对一致）。
- 三种语言产出完全相同结构的步骤数据，因此界面渲染逻辑（`js/app.js`）是共用的。
- 所有解析与执行都在你的浏览器本地完成（Python 首次使用除外，需要联网下载运行环境本身），代码不会上传到任何服务器。

## 目录结构

源码按文件拆分以便维护，`index.html` 由 `build.js` 从这些源文件内联生成（发布产物是单文件，不代表开发时是单文件）：

```
index.template.html   页面骨架模板（含内联占位符）
build.js              构建脚本：node build.js 会重新生成 index.html
index.html            生成产物：完全自包含的单文件页面（直接使用这个文件）
css/style.css          样式（支持浅色/深色主题、移动端适配）
js/interpreter.js      JavaScript 解释器：解析并生成逐行执行的步骤快照
python/tracer.py       Python 追踪器源码 —— 是一个普通的 .py 文件，可以直接用 python3 检查/测试
js/py_runner.js        负责懒加载 Pyodide、把 python/tracer.py 的内容喂给它执行、桥接页面
js/java_interpreter.js Java 解释器：解析并生成逐行执行的步骤快照
js/java_runner.js      桥接 Java 解释器与页面（错误信息本地化等）
js/detect_methods.js   方法自动识别（正则启发式扫描代码里的可调用方法/函数，供参数式调用 UI 使用）
js/examples.js         内置示例代码（三种语言各一套）
js/app.js              界面逻辑：编辑器、语言切换、方法识别、多测试用例、播放控制、变量图形化/时间线/控制台渲染
vendor/acorn.js         第三方 JS 解析器 Acorn（本地内置，无需联网）
vendor/java-parser.js   第三方 Java 解析器 java-parser（本地内置，无需联网）
```

若修改了 `css/`、`js/`、`python/tracer.py` 或 `index.template.html`，运行 `node build.js` 重新生成 `index.html`。

**关于 `python/tracer.py`**：这是唯一的源文件（一个真正能用 `python3 python/tracer.py` 或直接 `import` 测试的
普通 Python 文件），`build.js` 用 `` String.raw`...` `` 把它整个包成一个 JS 字符串塞进页面——用 `String.raw` 而不是普通
模板字符串是关键：普通模板字符串会把源码里 `'\n'` 这样的 Python 转义序列在浏览器解析这个 `<script>` 标签时就当作
"真的换行符" 解码掉，导致喂给 Pyodide 的 Python 源码里出现裸露的换行，触发 `SyntaxError: unterminated string
literal`（这个坑真实地导致过一版 Python 模式完全跑不起来）。`build.js` 里也加了一个检查：如果
`python/tracer.py` 出现反引号或 `${`，会直接构建失败提示修正，防止再踩同一类坑。
