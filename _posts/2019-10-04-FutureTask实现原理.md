---
layout: post
title: FutureTask实现原理
date: "2019-10-04 15:00:00 +0800"
categories: multithread
tags: java multithread concurrency
published: true
---

## 前言
**Future** 是Java中对一个异步计算结果的抽象。Java并发包中提供了一个`java.util.concurrent.Future`接口用于抽象异步计算结果。`Future`接口提供了一系列接口来访问异步计算结果，比如我们最常用的`get()`方法。

`Future`只是一个接口，至于内部如何实现异步计算结果的访问则完全和具体实现相关。在Java并发包中提供了一个`Future`实现`FutureTask`，用于和线程池`ThreadPoolExecutor`一起搭配使用。在我们使用线程池`submit()`一个任务的时候会返回一个`Future`对象，在这里这个对象的具体实现就是`FutureTask`。下面我们来分析下`FutureTask`的具体实现原理。

*注：本文的原理分析基于JDK8的源码。*

## Future接口
`FutureTask`类实现了`Future`接口。`Future`接口抽象了异步计算的结果，就像接口名称所表示的那样：`Future`对象持有的是一个未来的结果，这个未来的结果通过异步方式计算得到。`Future`对象提供了一系列的方法来完成和异步计算结果的交互。

{% highlight java %}
public interface Future<V> {
    boolean cancel(boolean mayInterruptIfRunning);
    boolean isCancelled();
    boolean isDone();
    V get() throws InterruptedException, ExecutionException;
    V get(long timeout, TimeUnit unit)
        throws InterruptedException, ExecutionException, TimeoutException;
}
{% endhighlight %}

`Future`接口提供的`get()`方法用于阻塞获取异步计算结果，`cancel()`方法用于取消异步计算任务。所以可以发现：`Future`对象一方面抽象了异步计算结果；另一方面`Future`本质上是一种实现线程间同步的组件：协调提交计算的线程和执行计算的线程。具体到`FutureTask`实现，它的作用就是在提交任务的线程和线程池中执行任务的工作线程之间提供某种同步机制。

为了实现`get()`和`cancel()`方法，`Future`的实现类需要解决三个问题：

1. 如何实现异步计算结果的传递和访问。
2. 如何实现线程同步。
3. 如何对执行异步计算的线程进行控制（取消）。

对于实现`get()`方法来说面临了问题1和问题2，而问题3是实现`cancel()`需要面临的问题。下面我们来看看`FutureTask`是如何解决这三个问题的。

## FutureTask实现

首先，`FutureTask`实现了`RunnableFuture`接口，而`RunnableFuture`接口实现了`Runnable`和`Future`接口，所以`FutureTask`本身就是一个`Runnable`对象，可以作为一个任务被线程池执行。

{% highlight java %}
public interface RunnableFuture<V> extends Runnable, Future<V> {
    void run();
}
{% endhighlight %}

线程池`ThreadPoolExecutor`继承的父类`AbstractExecutorService`中提供一个`newTaskFor()`方法，提供了从`Callable`或者`Runnable`类型的对象转换到`RunnableFuture`类型对象的适配能力。

{% highlight java %}
public abstract class AbstractExecutorService implements ExecutorService {
  ...
  protected <T> RunnableFuture<T> newTaskFor(Runnable runnable, T value) {
      return new FutureTask<T>(runnable, value);
  }
  
  public Future<?> submit(Runnable task) {
    if (task == null) throw new NullPointerException();
    RunnableFuture<Void> ftask = newTaskFor(task, null);
    execute(ftask);
    return ftask;
  }

  public <T> Future<T> submit(Runnable task, T result) {
      if (task == null) throw new NullPointerException();
      RunnableFuture<T> ftask = newTaskFor(task, result);
      execute(ftask);
      return ftask;
  }

  public <T> Future<T> submit(Callable<T> task) {
      if (task == null) throw new NullPointerException();
      RunnableFuture<T> ftask = newTaskFor(task);
      execute(ftask);
      return ftask;
  }
  ...
}
{% endhighlight %}

`newTaskFor()`方法是一个`protected`修饰的方法，在继承`AbstractExecutorService`的子类中可以自行实现适配逻辑。`ThreadPoolExecutor`使用的是`AbstractExecutorService`的默认实现：将`Runnable`或`Callable`对象包装成`FutureTask`对象。下面我们来看下`FutureTask`内部是如何表示被转换的任务的。

{% highlight java %}
public class FutureTask<V> implements RunnableFuture<V> {
    ...
    /** The underlying callable; nulled out after running */
    private Callable<V> callable;
    /** The result to return or exception to throw from get() */
    private Object outcome; // non-volatile, protected by state reads/writes
    /** The thread running the callable; CASed during run() */
    private volatile Thread runner;
    /** Treiber stack of waiting threads */
    private volatile WaitNode waiters;

    public FutureTask(Callable<V> callable) {
        if (callable == null)
            throw new NullPointerException();
        this.callable = callable;
        this.state = NEW;       // ensure visibility of callable
    }

    public FutureTask(Runnable runnable, V result) {
        this.callable = Executors.callable(runnable, result);
        this.state = NEW;       // ensure visibility of callable
    }    
    
    public void run() {
        if (state != NEW ||
            !UNSAFE.compareAndSwapObject(this, runnerOffset,
                                         null, Thread.currentThread()))
            return;
        try {
            Callable<V> c = callable;
            if (c != null && state == NEW) {
                V result;
                boolean ran;
                try {
                    result = c.call();
                    ran = true;
                } catch (Throwable ex) {
                    result = null;
                    ran = false;
                    setException(ex);
                }
                if (ran)
                    set(result);
            }
        } finally {
            // runner must be non-null until state is settled to
            // prevent concurrent calls to run()
            runner = null;
            // state must be re-read after nulling runner to prevent
            // leaked interrupts
            int s = state;
            if (s >= INTERRUPTING)
                handlePossibleCancellationInterrupt(s);
        }
    }
    ...
}
{% endhighlight %}

这里我们可以看到，`FutureTask`提供了两个构造方法将传入的`Runnable`对象和`Callable`对象存储到一个`Callable`类型的成员变量`callable`中，然后通过改写`run()`方法来重写任务执行的逻辑。

### 同步

前面我们提到`Future`本质上是实现了两个线程间的同步。为了支持状态查询、`get()`和`cancel()`操作，`FutureTask`的实现通过状态控制来实现线程间的同步的。具体来说，`FutureTask`内部维护了一个`volatile`修饰的`state`字段，用于跟踪`FutureTask`执行的状态，状态的变更是通过`Unsafe`类中的CAS操作完成的。`FutureTask`定义了7种状态：

| 状态 | 值 | 描述 |
| --- + -- + --- |
|NEW | 0 | 任务的初始状态 |
|COMPLETING | 1 | 任务执行完成状态 |
|NORMAL | 2 | 任务正常结束的终态 |
|EXCEPTIONAL | 3 | 任务执行过程中抛出了异常 |
|CANCELLED | 4 | 任务被取消 |
|INTERRUPTING | 5 | 执行任务的线程被中断 |
|INTERRUPTED | 6 | 中断成功 |

`FutureTask`中定义的这些状态通过方法调用触发状态的跃迁。在状态跃迁过程时，通过CAS操作满足原子性操作。由于存储状态的字段`state`被修饰了`volatile`，所以在满足了 **happen-before原则** 的更新中可以通过非阻塞的方式保护数据被安全地访问，这在后面具体分析源码的过程中我们会再次提到。下面是状态的跃迁图：

![state](/assets/images/future_task_0.png){:width="50%" hight="50%"}

### run( )方法
`FutureTask`通过重写`Runnable`的`run()`方法实现对任务执行逻辑的控制。`FutureTask`中关于异步计算获取和结果同步的核心逻辑都封装在`run()`方法中，下面我们来一窥究竟：

{% highlight java %}
public void run() {
    if (state != NEW ||
        !UNSAFE.compareAndSwapObject(this, runnerOffset,
                                     null, Thread.currentThread()))
        return;
    try {
        Callable<V> c = callable;
        if (c != null && state == NEW) {
            V result;
            boolean ran;
            try {
                result = c.call();
                ran = true;
            } catch (Throwable ex) {
                result = null;
                ran = false;
                setException(ex);
            }
            if (ran)
                set(result);
        }
    } finally {
        // runner must be non-null until state is settled to
        // prevent concurrent calls to run()
        runner = null;
        // state must be re-read after nulling runner to prevent
        // leaked interrupts
        int s = state;
        if (s >= INTERRUPTING)
            handlePossibleCancellationInterrupt(s);
    }
}
{% endhighlight %}

在`run()`方法，执行的第一步是先判断当前`FutureTask`的状态，如果当前状态是`NEW`并且`runner`的值为`null`则表示任务可以被执行。`runner`的值记录了执行当前任务的线程，如果`runner`的值不为`null`则表示已经有线程在执行这个任务了。

满足执行条件以后，开始执行存储在`callable`成员变量中的任务。如果执行成功则将任务执行的结果通过`set()`方法将值保存到`outcome`成员变量中。

{% highlight java %}
protected void set(V v) {
    if (UNSAFE.compareAndSwapInt(this, stateOffset, NEW, COMPLETING)) {
        outcome = v;
        UNSAFE.putOrderedInt(this, stateOffset, NORMAL); // final state
        finishCompletion();
    }
}
{% endhighlight %}

在`set()`方法中，先将状态转换到`COMPLETING`状态，然后将结果存储到`outcome`中。最后将状态变成`NORMAL`。

如果在执行任务的过程中抛出了异常，则会调用`setException()`方法将异常对象存储到`outcome`中，同时将线程池的状态变成`EXCEPTIONAL`，这里复用了`outcome`成员变量来存储异常对象。

{% highlight java %}
protected void setException(Throwable t) {
    if (UNSAFE.compareAndSwapInt(this, stateOffset, NEW, COMPLETING)) {
        outcome = t;
        UNSAFE.putOrderedInt(this, stateOffset, EXCEPTIONAL); // final state
        finishCompletion();
    }
}
{% endhighlight %}

通过`run()`方法我们可以发现，`FutureTask`的状态在`NEW`的时候，任务可能还未被执行，也有可能真正执行中，所以需要`runner`来做进一步的判断。如果`runner`不为`null`则表示任务已经被分配了一个线程，否则就是未执行状态，所以`FutureTask`的状态在跃迁到`COMPLETING`的时候就表示任务已经被执行过了，至于是否正常执行完成则需要后面的两个状态`NORMAL`和`EXCEPTIONAL`来进一步表示。

### 获取结果

`Future`提供了`get()`方法来获取异步计算结果。`Future`的`get()`方法有两个版本，一个是永久阻塞版本的`get()`，一个是支持超时返回的`get()`方法。我们先来看下第一个版本的实现：

{% highlight java %}
public V get() throws InterruptedException, ExecutionException {
    int s = state;
    if (s <= COMPLETING)
        s = awaitDone(false, 0L);
    return report(s);
}
{% endhighlight %}

首先检查当前的状态是否是`NEW`，如果是则需要等待，否则执行`report()`方法将结果返回：

{% highlight java %}
private V report(int s) throws ExecutionException {
    Object x = outcome;
    if (s == NORMAL)
        return (V)x;
    if (s >= CANCELLED)
        throw new CancellationException();
    throw new ExecutionException((Throwable)x);
}
{% endhighlight %}

在`report()`方法中，检查当前状态是否是`NORMAL`，如果是则表示任务正常执行结束，返回异步计算的结果。否则判断任务是被取消了还是执行过程中抛出了异常，如果被取消则抛出`CancellationException`异常，如果是执行过程中抛了异常，则将异常放入异常链中并抛出`ExecutionException`异常。

分析到这里，我们已经知道了`FutureTask`的实现是如何将异步计算的结果传递到外部的：由于线程是共享内存空间的，所以这里通过线程同步机制保证了数据被线程安全传递。  

但是这里需要注意一个点：`outcome`在声明的时候是一个普通的成员对象，并没有修饰为`volatile`，而且`outcome`的访问也没有加锁。虽然在Java中赋值操作是原子操作，但是满足线程安全性的前提除了原子性以外还有可见性。那可见性是如何被保证的呢？答案是通过满足JMM（Java内存模型）中的 **Happen-Before原则** 来实现。

我们来重新看下`set()`和`report()`方法的实现：

{% highlight java %}
protected void set(V v) {
    if (UNSAFE.compareAndSwapInt(this, stateOffset, NEW, COMPLETING)) {
        outcome = v;
        UNSAFE.putOrderedInt(this, stateOffset, NORMAL); // final state
        finishCompletion();
    }
}

private V report(int s) throws ExecutionException {
    Object x = outcome;
    if (s == NORMAL)
        return (V)x;
    if (s >= CANCELLED)
        throw new CancellationException();
    throw new ExecutionException((Throwable)x);
}
{% endhighlight %}

这里保证`outcome`可以线程安全地被访问运用了 **Happen-Before** 原则中的其中三条：
> 程序次序规则
> : 一个线程内，按照代码顺序，书写在前面的操作先行发生于书写在后面的操作
>
> volatile变量规则
> : 对一个volatile变量的写操作先行发生于后面对这个变量的读操作
>
> 传递规则
> : 如果操作A先行发生于操作B，而操作B又先行发生于操作C，则可以得出操作A先行发生于操作C

首先，`state`是一个修饰了`volatile`关键字的成员变量，满足内存的可见性要求和 **Happen-Before** 原则中的 **volatile变量规则**。

当`set()`被执行的时候，先将值`outcome`设置为`v`，然后调用`UNSAFE.putOrderedInt(this, stateOffset, NORMAL)`将state的值设置为`NORMAL`。这里没有直接用赋值操作而是用`Unsafe`的`putOrderedInt()`方式是为了优化`volatile`变量的写操作。这里`outcome`和`state`的赋值语句的先后顺序很重要，需要满足 **程序次序规则**。同理，在`report()`中，入参是在`get()`中获取的`state`值，所以对`state`的读操作先于`Object x = outcome`发生。如果我们把 **Happen-Before** 的第三条传递规则加上，刚才描述的过程会对应于这样一个执行流：

{% highlight java %}
1. write outcome v
2. write state NORMAL
3. read state
4. read outcome
{% endhighlight %}

这个执行流就保证了对`outcome`的写肯定是先于对`outcome`的读发生的，实现了`outcome`的可见性。

下面开始分析阻塞逻辑。由于`Future`表示的是一个异步计算的结果，既然计算过程是异步的，那么就需要某种同步机制来协调两个线程。在Java多线程中，我们常用的线程间同步方式是使用`wait-notify/notifyAll`机制。不同于这个方案，在`FutureTask`的实现中，采用的是基于`Unsafe`的`park()`和`unpark()`操作来实现线程的阻塞和唤醒，阻塞线程的集合则是通过维护一个无锁栈数据结构 **Treiber stack** 来实现的。

### Treiber stack

Treiber stack是一种 **栈** 数据结构，最早是由 **R. Kent Treiber** 在1986年的发布的论文《Systems Programming: Coping with Parallelism》中提出[^1]，支持无锁入栈和出栈操作，在并发情况下有良好的访问性能。

Treiber stack结构上和普通的栈数据结构没有区别，唯一的不同是在入栈和出栈的时候，不同于阻塞的数据结构：需要加锁来保护栈顶指针，在Treiber stack的实现中，采用了CompareAndSwap机制来更新栈顶的指针以实现无锁入队和出队操作。

![stack](/assets/images/future_task_1.png){:width="25%" hight="25%"}

一个例子：

{% highlight java %}
public class ConcurrentStack <E> {
    AtomicReference<Node<E>> top = new AtomicReference<Node<E>>();

    public void push(E item) {
        Node<E> newHead = new Node<E>(item);
        Node<E> oldHead;
        do {
            oldHead = top.get();
            newHead.next = oldHead;
        } while (!top.compareAndSet(oldHead, newHead)); // CAS操作栈顶指针
    }

    public E pop() {
        Node<E> oldHead;
        Node<E> newHead;
        do {
            oldHead = top.get();
            if (oldHead == null)
                return null;
            newHead = oldHead.next;
        } while (!top.compareAndSet(oldHead, newHead)); // CAS操作栈顶指针
        return oldHead.item;
    }

    private static class Node <E> {
        public final E item;
        public Node<E> next;

        public Node(E item) {
            this.item = item;
        }
    }
}
{% endhighlight %}

`FutureTask`的Treiber stack实现，使用`WaitNode`作为栈中的元素，通过`next`成员变量来联结栈中的元素。通过`awaitDone()`和`finishCompletion()`来完成入栈和出栈操作。

{% highlight java %}
static final class WaitNode {
    volatile Thread thread;
    volatile WaitNode next;
    WaitNode() { thread = Thread.currentThread(); }
}
{% endhighlight %}

### 阻塞和唤醒

`get()`方法的阻塞逻辑在`awaitDone()`中：

{% highlight java %}
private int awaitDone(boolean timed, long nanos)
    throws InterruptedException {
    final long deadline = timed ? System.nanoTime() + nanos : 0L;
    WaitNode q = null;
    boolean queued = false;
    for (;;) {
        if (Thread.interrupted()) {
            removeWaiter(q);
            throw new InterruptedException();
        }

        int s = state;
        if (s > COMPLETING) {
            if (q != null)
                q.thread = null;
            return s;
        }
        else if (s == COMPLETING) // cannot time out yet
            Thread.yield();
        else if (q == null)
            q = new WaitNode();
        else if (!queued)
            queued = UNSAFE.compareAndSwapObject(this, waitersOffset,
                                                 q.next = waiters, q);
        else if (timed) {
            nanos = deadline - System.nanoTime();
            if (nanos <= 0L) {
                removeWaiter(q);
                return state;
            }
            LockSupport.parkNanos(this, nanos);
        }
        else
            LockSupport.park(this);
    }
}
{% endhighlight %}

`awaitDone()`支持一个超时时间参数，如果在超时时间内（如果超时时间大于0）状态没有进入完成或者取消状态，则执行`UNSAFE.compareAndSwapObject(this, waitersOffset, q.next = waiters, q)`进行入栈操作并调用`LockSupport.park(this)`将调用线程挂起。如果超时或者等待的线程被中断了，则需要调用`removeWaiter()`将之前入栈的那个`WaitNode`对象从栈中删除。

当任务执行完成以后，`FutureTask`会调用`finishCompletion()`对栈中的所有对象逐个调用`LockSupport.unpark(t)`唤醒阻塞的线程并出栈。

{% highlight java %}
private void finishCompletion() {
    // assert state > COMPLETING;
    for (WaitNode q; (q = waiters) != null;) {
        if (UNSAFE.compareAndSwapObject(this, waitersOffset, q, null)) {
            for (;;) {
                Thread t = q.thread;
                if (t != null) {
                    q.thread = null;
                    LockSupport.unpark(t);
                }
                WaitNode next = q.next;
                if (next == null)
                    break;
                q.next = null; // unlink to help gc
                q = next;
            }
            break;
        }
    }
    done();
    callable = null;        // to reduce footprint
}
{% endhighlight %}

### 取消任务
下面我们来看下`FutureTask`是如何取消任务的。

{% highlight java %}
public boolean cancel(boolean mayInterruptIfRunning) {
    if (!(state == NEW &&
          UNSAFE.compareAndSwapInt(this, stateOffset, NEW,
              mayInterruptIfRunning ? INTERRUPTING : CANCELLED)))
        return false;
    try {    // in case call to interrupt throws exception
        if (mayInterruptIfRunning) {
            try {
                Thread t = runner;
                if (t != null)
                    t.interrupt();
            } finally { // final state
                UNSAFE.putOrderedInt(this, stateOffset, INTERRUPTED);
            }
        }
    } finally {
        finishCompletion();
    }
    return true;
}
{% endhighlight %}

`cancel()`方法支持一个`mayInterruptIfRunning`参数，表示是否允许中断运行中的任务。首先检查当前的状态，如果当前状态是`NEW`则基于参数`mayInterruptIfRunning`的值将状态跃迁到`INTERRUPTING`或`CANCELLED`。如果不需要中断运行中的任务则直接跃迁到`CANCELLED`状态。如果状态跃迁的CAS操作失败了，则表示任务已经执行完成了任务不能被取消，所以直接返回false。如果在修改完状态以后任务仍旧在执行中，那么当`mayInterruptIfRunning`为`true`的时候需要对执行中的线程进行中断，最后将状态跃迁到`INTERRUPTED`状态。

在状态从`INTERRUPTING`跃迁到`INTERRUPTED`之间有一个时间窗口，如果在这个时间窗口中执行任务的线程执行成功了，那么可能会丢失`cancel()`发起的中断信号。为了解决这个问题，`run()`方法在`finally`中会调用`handlePossibleCancellationInterrupt()`方法。这个方法的作用是当状态是`INTERRUPTING`的时候，目标线程需要等到`cancel()`发出中断命令且目标线程接收到中断命令以后再返回，以保证中断命令不会丢失。

{% highlight java %}
private void handlePossibleCancellationInterrupt(int s) {
    // It is possible for our interrupter to stall before getting a
    // chance to interrupt us.  Let's spin-wait patiently.
    if (s == INTERRUPTING)
        while (state == INTERRUPTING)
            Thread.yield(); // wait out pending interrupt
}
{% endhighlight %}

在`cancel()`和`handlePossibleCancellationInterrupt()`之间保证了一个时序操作，保证中断信号不丢失。

## 总结
上面我们分析了`FutureTask`实现的原理，介绍了如何解决同步异步转换（阻塞-通知）、传递计算结果以及取消任务这三个问题。

[^1]: [https://en.wikipedia.org/wiki/Treiber_stack](https://en.wikipedia.org/wiki/Treiber_stack)

