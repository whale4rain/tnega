import unittest

from math import fib


class FibTest(unittest.TestCase):
    def test_small(self):
        self.assertEqual(fib(0), 0)
        self.assertEqual(fib(1), 1)
        self.assertEqual(fib(5), 5)
        self.assertEqual(fib(10), 55)


if __name__ == "__main__":
    unittest.main()
