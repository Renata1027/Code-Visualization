// 内置示例代码，帮助用户快速了解可视化工具的用法
window.CODE_EXAMPLES = {
  '累加循环 (for loop)': `let sum = 0;
for (let i = 1; i <= 5; i++) {
  sum += i;
}
console.log('sum =', sum);
`,

  '斐波那契递归 (recursion)': `function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

let result = fib(6);
console.log('fib(6) =', result);
`,

  '冒泡排序 (bubble sort)': `function bubbleSort(arr) {
  for (let i = 0; i < arr.length - 1; i++) {
    for (let j = 0; j < arr.length - 1 - i; j++) {
      if (arr[j] > arr[j + 1]) {
        let tmp = arr[j];
        arr[j] = arr[j + 1];
        arr[j + 1] = tmp;
      }
    }
  }
  return arr;
}

const data = [5, 3, 8, 1, 2];
console.log(bubbleSort(data));
`,

  '数组与对象 (arrays & objects)': `const nums = [1, 2, 3, 4, 5];
const doubled = nums.map(n => n * 2);
const evens = doubled.filter(n => n % 4 === 0);

const person = { name: 'Ada', age: 30 };
person.age += 1;

console.log(doubled, evens, person);
`,

  '异常处理 (try/catch)': `function divide(a, b) {
  if (b === 0) {
    throw new Error('除数不能为 0');
  }
  return a / b;
}

let result;
try {
  result = divide(10, 0);
} catch (e) {
  console.log('出错了:', e.message);
  result = null;
}
console.log('result =', result);
`,
};
