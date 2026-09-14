// 内置示例代码。每个示例包含 code（代码）和 entry（可选的调用入口表达式，LeetCode 风格）
window.EXAMPLES = {
  javascript: {
    '累加循环 (for loop)': {
      code: `let sum = 0;
for (let i = 1; i <= 5; i++) {
  sum += i;
}
console.log('sum =', sum);
`,
      entry: '',
    },
    '斐波那契递归 (recursion)': {
      code: `function fib(n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}
`,
      entry: 'fib(6)',
    },
    '冒泡排序 (bubble sort)': {
      code: `function bubbleSort(arr) {
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
`,
      entry: 'bubbleSort([5, 3, 8, 1, 2])',
    },
    'LeetCode 风格：两数之和': {
      code: `var twoSum = function (nums, target) {
  const seen = {};
  for (let i = 0; i < nums.length; i++) {
    const need = target - nums[i];
    if (seen[need] !== undefined) {
      return [seen[need], i];
    }
    seen[nums[i]] = i;
  }
  return [];
};
`,
      entry: 'twoSum([2, 7, 11, 15], 9)',
    },
    '异常处理 (try/catch)': {
      code: `function divide(a, b) {
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
      entry: '',
    },
  },

  python: {
    '累加循环 (for loop)': {
      code: `total = 0
for i in range(1, 6):
    total += i
print('total =', total)
`,
      entry: '',
    },
    '斐波那契递归 (recursion)': {
      code: `def fib(n):
    if n <= 1:
        return n
    return fib(n - 1) + fib(n - 2)
`,
      entry: 'fib(6)',
    },
    '冒泡排序 (bubble sort)': {
      code: `def bubble_sort(arr):
    for i in range(len(arr) - 1):
        for j in range(len(arr) - 1 - i):
            if arr[j] > arr[j + 1]:
                arr[j], arr[j + 1] = arr[j + 1], arr[j]
    return arr
`,
      entry: 'bubble_sort([5, 3, 8, 1, 2])',
    },
    'LeetCode 风格：子集 (backtracking)': {
      code: `class Solution:
    def subsets(self, nums):
        ans = []
        path = []

        def backtrack(start):
            ans.append(path[:])
            for i in range(start, len(nums)):
                path.append(nums[i])
                backtrack(i + 1)
                path.pop()

        backtrack(0)
        return ans
`,
      entry: 'Solution().subsets([1, 2, 3])',
    },
    '异常处理 (try/except)': {
      code: `def divide(a, b):
    if b == 0:
        raise ValueError('除数不能为 0')
    return a / b

result = None
try:
    result = divide(10, 0)
except ValueError as e:
    print('出错了:', e)
    result = None
print('result =', result)
`,
      entry: '',
    },
  },

  java: {
    '累加循环 (for loop)': {
      code: `class Solution {
    public static void main(String[] args) {
        int sum = 0;
        for (int i = 1; i <= 5; i++) {
            sum += i;
        }
        System.out.println("sum = " + sum);
    }
}
`,
      entry: '',
    },
    '斐波那契递归 (recursion)': {
      code: `class Solution {
    public int fib(int n) {
        if (n <= 1) return n;
        return fib(n - 1) + fib(n - 2);
    }
}
`,
      entry: 'new Solution().fib(6)',
    },
    '冒泡排序 (bubble sort)': {
      code: `class Solution {
    public int[] bubbleSort(int[] arr) {
        for (int i = 0; i < arr.length - 1; i++) {
            for (int j = 0; j < arr.length - 1 - i; j++) {
                if (arr[j] > arr[j + 1]) {
                    int tmp = arr[j];
                    arr[j] = arr[j + 1];
                    arr[j + 1] = tmp;
                }
            }
        }
        return arr;
    }
}
`,
      entry: 'new Solution().bubbleSort(new int[]{5, 3, 8, 1, 2})',
    },
    'LeetCode 风格：子集 (backtracking)': {
      code: `import java.util.*;

class Solution {
    public List<List<Integer>> subsets(int[] nums) {
        List<List<Integer>> ans = new ArrayList<>();
        List<Integer> path = new ArrayList<>();
        backtrack(nums, 0, path, ans);
        return ans;
    }

    private void backtrack(int[] nums, int start, List<Integer> path, List<List<Integer>> ans) {
        ans.add(new ArrayList<>(path));
        for (int i = start; i < nums.length; i++) {
            path.add(nums[i]);
            backtrack(nums, i + 1, path, ans);
            path.remove(path.size() - 1);
        }
    }
}
`,
      entry: 'new Solution().subsets(new int[]{1, 2, 3})',
    },
    '异常处理 (try/catch)': {
      code: `class Solution {
    static double divide(int a, int b) {
        if (b == 0) {
            throw new ArithmeticException("除数不能为 0");
        }
        return (double) a / b;
    }

    public static void main(String[] args) {
        double result;
        try {
            result = divide(10, 0);
        } catch (ArithmeticException e) {
            System.out.println("出错了: " + e.getMessage());
            result = -1;
        }
        System.out.println("result = " + result);
    }
}
`,
      entry: '',
    },
  },
};
