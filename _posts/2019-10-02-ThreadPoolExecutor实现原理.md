---
layout: post
title: ThreadPoolExecutor实现原理
date: "2019-10-02 20:44:00 +0800"
categories: multithread
tags: java multithread concurrency
published: true
---

## 前言

在Java中，日常大家用的最多的线程池就是`ThreadPoolExecutor`，它是由 **Doug Lea** 实现并在JDK 1.5中随着`java.util.concurrency`并发包一起被引入。本文将通过源码分析带大家一窥`ThreadPoolExecutor`的实现原理，了解线程池的设计和实现。

*本文假设读者已经对线程池的概念有所了解，并且有Java线程池的相关使用经验。文中分析的源码基于JDK 8。*

## 线程池结构

在深入了解`ThreadPoolExecutor`的实现之前，我们先来看下它的结构。在类继承体系中，`ThreadPoolExecutor`继承了`AbstractExecutorService`，`AbstractExecutorService`实现了`ExecutorService`接口，`ExecutorService`继承了`Executor`接口。

![thread_pool_executor类图](/assets/images/threadpoolexecutor_0.png){:width="25%" hight="25%"}

`Executor`接口中只定了一个`execute()`方法，它是线程池执行任务的入口。我们平时使用的`submit()`方法是在`ExecutorService`中定义的，在底层是实现上也是通过调用`Executor`中的`execute()`方法实现的。`ExecutorService`接口中提供了线程池的管理方法，包括`shutdown()`和`shutdownNow()`，以及一系列的任务提交方法`submit()`。

在`ThreadPoolExecutor`中定义了一个任务队列`workerQueue`以及一个工作线程集合`workers`。通过实现一个 **生产者-消费者** 模型来处理提交给线程池的任务，通过管理`workers`中的工作线程来是实现线程池的伸缩，通过`workerQueue`实现任务管理。

![生产者消费者模型](/assets/images/threadpoolexecutor_1.png){:width="55%" hight="55%"}

## 工作线程
在`ThreadPoolExecutor`的实现中，工作线程通过`Worker`来抽象，一个`Worker`表示一个在线程池中实际处理任务的工作单元。`Worker`实现了`Runnable`接口，并且继承了`AbstractQueuedSynchronizer`类。

`Worker`继承`AbstractQueuedSynchronizer`类的目的是为了实现一个互斥锁，这个互斥锁提供了`lock()`、`tryLock()`、`unlock()`以及`isLocked()`方法。

{% highlight java %}
public void lock()        { acquire(1); }
public boolean tryLock()  { return tryAcquire(1); }
public void unlock()      { release(1); }
public boolean isLocked() { return isHeldExclusively(); }
{% endhighlight %}

在后面执行任务那一节会看到，执行任务的过程中worker是会加锁的，所以可以通过判断worker是否加锁来判断worker是否处于空闲（idle）状态。

在`Worker`中定义了三个成员变量：`thread`、`firstTask`、`completedTasks`，分别表示`Worker`对应的线程对象、第一个被执行的任务（可能为空）以及这个`Worker`执行任务的总数（为了统计线程池的执行任务数而加的一个字段）。

{% highlight java %}
private final class Worker
        extends AbstractQueuedSynchronizer
        implements Runnable
{
        /* 省略 */
        Worker(Runnable firstTask) {
            setState(-1); // inhibit interrupts until runWorker
            this.firstTask = firstTask;
            this.thread = getThreadFactory().newThread(this);
        }

        /** Delegates main run loop to outer runWorker  */
        public void run() {
            runWorker(this);
        }
        /* 省略 */
}
{% endhighlight %}

在创建`Worker`实例的时候，通过将`Runnable`对象传递给`Thread`对象来创建线程，所以当线程启动的时候会执行worker的`run()`方法，`run()`方法将具体执行任务的细节委托给了`ThreadPoolExecutor`的`runWorker()`方法。在深入分析处理任务的细节之前，我们先看下线程池是如何表示状态的。

## 线程池状态
`ThreadPoolExecutor`在记录线程池的状态和当前线程池中工作线程数量的时候没有使用两个单独的字段来表示，而是通过一个`int`类型的值将这两部分信息打包存储（pack）在二进制位（bit）中。

![pack](/assets/images/threadpoolexecutor_2.png){:width="55%" hight="55%"}

在`int`类型的32位中，除了最高位为0以外，剩下的31位中，高2位表示线程池的状态，剩下的29位表示当前线程池中工作线程的数量，表示范围为$0$ ~ $2^{29} - 1$，这个容量的最大值通过静态变量`CAPACITY`表示。

线程池中状态通过2个二进制位（bit）表示，用来表示线程池定义的5个状态：`RUNNING`、`SHUTDOWN`、`STOP`、`TIDYING`和`TERMINATED`。

RUNNING
: 线程池正常工作的状态，在 **RUNNING** 状态下线程池接受新的任务并处理任务队列中的任务。

SHUTDOWN
: 调用`shutdown()`方法会进入 **SHUTDOWN** 状态。在 **SHUTDOWN** 状态下，线程池不接受新的任务，但是会继续执行任务队列中已有的任务。

STOP
: 调用`shutdownNow()`会进入 **STOP** 状态。在 **STOP** 状态下线程池既不接受新的任务，也不处理已经在队列中的任务。对于还在执行任务的工作线程，线程池会发起中断请求来中断正在执行的任务，同时会清空任务队列中还未被执行的任务。

TIDYING
: 当线程池中的所有执行任务的工作线程都已经终止，并且工作线程集合为空的时候，进入 **TIDYING** 状态。

TERMINATED
: 当线程池执行完`terminated()`钩子方法以后，线程池进入终态 **TERMINATED** 。

下面是线程池完整的状态转换图：

![状态转换图](/assets/images/threadpoolexecutor_3.png){:width="70%" hight="70%"}

## 任务执行
线程池`ThreadPoolExecutor`通过队列解耦了任务执行和任务添加，我们先来分析下线程池是如何执行任务的。前面介绍`Worker`的时候提到了，工作线程在处理任务的时候是调用了`runWorker()`方法，下面我们来分析`runWorker()`的逻辑：

{% highlight java %}
final void runWorker(Worker w) {
    Thread wt = Thread.currentThread();
    Runnable task = w.firstTask;
    w.firstTask = null;
    w.unlock(); // allow interrupts
    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) {
            w.lock();
            // If pool is stopping, ensure thread is interrupted;
            // if not, ensure thread is not interrupted.  This
            // requires a recheck in second case to deal with
            // shutdownNow race while clearing interrupt
            if ((runStateAtLeast(ctl.get(), STOP) ||
                 (Thread.interrupted() &&
                  runStateAtLeast(ctl.get(), STOP))) &&
                !wt.isInterrupted())
                wt.interrupt();
            try {
                beforeExecute(wt, task);
                Throwable thrown = null;
                try {
                    task.run();
                } catch (RuntimeException x) {
                    thrown = x; throw x;
                } catch (Error x) {
                    thrown = x; throw x;
                } catch (Throwable x) {
                    thrown = x; throw new Error(x);
                } finally {
                    afterExecute(task, thrown);
                }
            } finally {
                task = null;
                w.completedTasks++;
                w.unlock();
            }
        }
        completedAbruptly = false;
    } finally {
        processWorkerExit(w, completedAbruptly);
    }
}
{% endhighlight %}

`runWorker()`的逻辑主要是一个`while`循环，在这个while循环中不断通过`getTask()`从任务队列中取出任务并执行任务的`run()`方法。如果`getTask()`返回`null`值，则退出循环并关闭工作线程。

在`while`循环内部开始执行具体任务的逻辑之前，先调用`Worker`的`lock()`方法锁住工作线程，这样在工作线程执行任务的过程中不会被外部中断和干扰，同时如果工作线程处于锁定状态，也表示当前工作先处于繁忙状态。然后在具体执行任务之前，先检查当前工作线程的中断状态：

{% highlight java %}
if ((runStateAtLeast(ctl.get(), STOP) ||
     (Thread.interrupted() &&
      runStateAtLeast(ctl.get(), STOP))) &&
    !wt.isInterrupted())
    wt.interrupt();
{% endhighlight %}

线程池需要保证工作线程的中断标记被正确的设置：
1. 如果线程池处于 **STOP** 状态，则必须保证工作线程的中断标记被设置
2. 如果线程池不处于 **STOP** 状态，则必须保证工作线程的中断标记被清除

所以为了保证上面两个点，`runStateAtLeast(ctl.get(), STOP)`用于检测第第一个情况，而在`Thread.interrupted() && runStateAtLeast(ctl.get(), STOP)`中，进行二次检测是为了防止在第一次检测的时候，如果线程池状态不是 **STOP** 状态，需要调用调用`Thread.interrupted()`清空线程池状态标记以满足上面第二个条件，但是在清空中断标记以后，可能存在并发更新导致线程池状态突然变成 **STOP** 的情况，所以需要再次检测一遍线程池的状态。如果满足上面的第一点，则调用`wt.interrupt()`中断当前的工作线程。

检测完中断标记以后，在开始执行具体的任务之前有一个`beforeExecute()`钩子方法，提供给开发者实现必要的前置逻辑，然后就是具体的任务执行逻辑`task.run()`，最后执行完成以后在`finally`中执行后置逻辑的钩子方法`afterExecute()`。在执行完一个任务以后，需要更新`completedTasks`统计指标并释放worker的锁。

## 容量管理
上面是任务执行的主流程，下面开始分析线程池如何进行扩容和缩容。

### 缩容
关于缩容，我们先从获取任务方法`getTask()`开始说起。下面是`getTask()`方法的逻辑：

{% highlight java %}
private Runnable getTask() {
    boolean timedOut = false; // Did the last poll() time out?

    for (;;) {
        int c = ctl.get();
        int rs = runStateOf(c);

        // Check if queue empty only if necessary.
        if (rs >= SHUTDOWN && (rs >= STOP || workQueue.isEmpty())) {
            decrementWorkerCount();
            return null;
        }

        int wc = workerCountOf(c);

        // Are workers subject to culling?
        boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;

        if ((wc > maximumPoolSize || (timed && timedOut))
            && (wc > 1 || workQueue.isEmpty())) {
            if (compareAndDecrementWorkerCount(c))
                return null;
            continue;
        }

        try {
            Runnable r = timed ?
                workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
                workQueue.take();
            if (r != null)
                return r;
            timedOut = true;
        } catch (InterruptedException retry) {
            timedOut = false;
        }
    }
}
{% endhighlight %}

在`getTask()`的`for`循环中首先检查线程池的状态，如果线程池状态是`SHUTDOWN`并且线程池中任务队列为空，则递减线程池中工作线程数量并返回`null`，`null`值对于`runWorker()`来说有特殊用途：通知获取任务的工作线程结束并退出。`ThreadPoolExecutor`通过`getTask()`的返回值来控制线程池的收缩。

{% highlight java %}
boolean timed = allowCoreThreadTimeOut || wc > corePoolSize;

if ((wc > maximumPoolSize || (timed && timedOut))
    && (wc > 1 || workQueue.isEmpty())) {
    if (compareAndDecrementWorkerCount(c))
        return null;
    continue;
}

try {
    Runnable r = timed ?
        workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
        workQueue.take();
    if (r != null)
        return r;
    timedOut = true;
} catch (InterruptedException retry) {
    timedOut = false;
}
{% endhighlight %}

线程池缩容需要满足两个条件：
1. 核心线程数量超过规定的数量
2. 存在空闲的工作线程

这里通过`allowCoreThreadTimeOut || wc > corePoolSize`判断线程池是否满足第一个条件，如果参数`allowCoreThreadTimeOut`为`true`，则表示允许当核心工作线程空闲的时候回收；如果`wc > corePoolSize` 为`true`，则表示当前工作线程数量超过核心线程数，如果有空闲的工作线程，则满足被回收的条件。所以这里用`timed`变量表示是否满足缩容的第一个条件。

第二个条件，也就是判断一个工作线程是否是空闲线程。线程池有一个`keepAliveTime`参数表示空闲线程存活的时间，在上面的代码中可以发现，在`ThreadPoolExecutor`的实现中是通过在队列`poll()`上设置超时时间来确定的，因为在线程池中，如果一个工作线程没有在执行任务，那么必然是阻塞在获取任务的操作上，所以这里利用阻塞队列的超时机制来对空闲时间进行计时。当`poll()`调用超时以后，变量`timeOut`被设置为`true`，表示当前工作线程是空闲状态的。然后进行下一轮循环的时候，在下面的条件判断中确定当前工作线程是否需要被回收：

{% highlight java %}
if ((wc > maximumPoolSize || (timed && timedOut))
    && (wc > 1 || workQueue.isEmpty())) {
    if (compareAndDecrementWorkerCount(c))
        return null;
    continue;
}
{% endhighlight %}

首先检查当前工作线程是否超过了最大线程数`maximumPoolSize`，正常情况下当前工作线程是不会超过最大线程数的，除非线程池的最大线程数被动态调整了，所以这里需要加上判断来响应线程池最大线程数动态调整的情况。如果最大线程数没有调整，那么就需要通过`timed && timeOut`判断当前工作线程满不满足回收条件。前面已经分析过了，`timeOut`变量表示当前工作线程是否是空闲工作线程，`timed`表示当前线程池中的线程数量是否超过了规定的数量，如果都为`true`则表示当前线程池中工作线程数量太多了并且当前工作线程是空闲线程，满足被回收的条件。

表达式`(wc > 1 || workQueue.isEmpty())`是为了保证任务队列不为空的情况下至少保留一个工作线程在工作，防止出现队列中还有任务但是没有工作线程的情况出现，因为一方面`timeOut`的测量是滞后的，特别是存在并发的情况下；另一方面是线程池的实现中没有一个单独的模块监测工作线程数量和待处理任务，所以在实现的时候需要在关键节点考虑这些情况出现的可能，`getTask()`就是其中一个关键节点。最后调用`compareAndDecrementWorkerCount()`来进行CAS方式扣减的目的是解决并发更新的情况。

下方是获取任务的流程图，其中灰色部分就是刚才我们分析的判断工作线程是否需要被回收的逻辑：

![缩容](/assets/images/threadpoolexecutor_6.png){:width="90%" hight="90%"}

一旦`getTask()`返回`null`，在`runWorker()`中就会执行`processWorkerExit()`方法处理工作线程退出的逻辑。

{% highlight java %}
private void processWorkerExit(Worker w, boolean completedAbruptly) {
    if (completedAbruptly) // If abrupt, then workerCount wasn't adjusted
        decrementWorkerCount();

    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock();
    try {
        completedTaskCount += w.completedTasks;
        workers.remove(w);
    } finally {
        mainLock.unlock();
    }

    tryTerminate();

    int c = ctl.get();
    if (runStateLessThan(c, STOP)) {
        if (!completedAbruptly) {
            int min = allowCoreThreadTimeOut ? 0 : corePoolSize;
            if (min == 0 && ! workQueue.isEmpty())
                min = 1;
            if (workerCountOf(c) >= min)
                return; // replacement not needed
        }
        addWorker(null, false);
    }
}
{% endhighlight %}

`processWorkerExit()`接受一个`Worker`对象和一个`completedAbruptly`参数，`completedAbruptly`参数表示工作线程是否是异常退出（由用户提交的任务抛出的异常导致的退出）。如果`completedAbruptly`为`true`，表示是用户代码导致的退出。正常退出逻辑我们在`getTask()`中已经分析过了，减少工作线程数量的逻辑在`getTask()`中已经实现了，所以在`processWorkerExit()`中只需要处理异常退出来时扣减工作线程数量的逻辑就可以了，这就是在执行`decrementWorkerCount()`的时候要判断下`completedAbruptly`的值的原因。

在退出的时候需要收集该工作线程曾经完成的任务数以统计整个线程池执行的任务数。然后触发`tryTerminate()`逻辑。`tryTerminate()`的作用是推动线程池进入 **TERMINATED** 状态。接下来再次获取线程池的状态，如果线程池还处于可以运行的状态则需要基于工作线程退出的原因完成不同的工作，如果是因为用户代码异常退出的（`completedAbruptly == true`），则需要调用`addWorker()`创建一个新的工作线程来接替当前将要退出的工作线程的工作。如果是因为正常缩容导致的工作线程退出则需要判断当前线程池的工作线程数量是否足够应付工作，如果足够应付工作就直接退出当前工作线程。

### 扩容

线程池通过`addWorker()`进行扩容，`addWorker()`接受两个参数：`firstTask`表示第一个被执行的任务，用于在首次创建worker的时候提供第一个将要被执行的任务，第二个参数`core`表示是否创建核心线程。

在`Worker`的实现中引入`firstTask`的目的，是为了在因增加任务而扩容场景下，任务可以直接传递给工作线程，而不是让任务进入队列排队等待工作线程被创建，然后由新创建的工作线程从队列中取出这个任务执行，这样会导致在大量任务同时进入的时候出现先进来的任务后执行，极端情况下任务可能会被丢给拒绝处理器处理。

{% highlight java %}
private boolean addWorker(Runnable firstTask, boolean core) {
    retry:
    for (;;) {
        int c = ctl.get();
        int rs = runStateOf(c);

        // Check if queue empty only if necessary.
        if (rs >= SHUTDOWN &&
            ! (rs == SHUTDOWN &&
               firstTask == null &&
               ! workQueue.isEmpty()))
            return false;

        for (;;) {
            int wc = workerCountOf(c);
            if (wc >= CAPACITY ||
                wc >= (core ? corePoolSize : maximumPoolSize))
                return false;
            if (compareAndIncrementWorkerCount(c))
                break retry;
            c = ctl.get();  // Re-read ctl
            if (runStateOf(c) != rs)
                continue retry;
            // else CAS failed due to workerCount change; retry inner loop
        }
    }
    ...
    /* 省略 */
}
{% endhighlight %}
`addWorker()`在创建工作线程之前需要先检查线程池的状态和当前任务队列中任务的数量以确定是否满足增加工作线程的条件，上面的代码检查四个点：

1. 如果线程池的状态是TIDYING或TERMINATED状态则不能再新增worker
2. 如果线程池存于SHUTDOWN状态并且任务队列为空则不能再新增worker
3. 如果线程池处于SHUTDOWN状态下`firstTask`不为空则不能再新增worker。在线程池中只有在提交任务的时候扩容才会出现入参`firstTask`不为空的情况，但是在SHUTDOWN状态下线程池不能再添加任务，所以不能因为为了添加任务而新增worker。
4. 检查线程池当前的容量，如果容量超过`CAPACITY`的限制或者超过核定容量则不能再新增worker。这里的核定容量是基于入参`core`判断的，如果`core`为`true`则核定容量为`corePoolSize`的值，否则就是设置的最大线程数量`maximumPoolSize`。

![扩容检查](/assets/images/threadpoolexecutor_7.png){:width="72%" hight="72%"}

如果上面四个条件都满足，则先进行容量值的递增，在增大容量值的时候通过`compareAndIncrementWorkerCount`进行CAS操作来处理并发扩容的情况。代码中使用两层`for`循环以及一系列的`break`、`continue`跳转语句的目的是为了配合CAS的方式来解决并发扩容的问题。当容量和状态检查都通过以后，就可以开始真正的扩容操作了：

{% highlight java %}
private boolean addWorker(Runnable firstTask, boolean core) {
    ...
    /* 省略 */

    boolean workerStarted = false;
    boolean workerAdded = false;
    Worker w = null;
    try {
        w = new Worker(firstTask);
        final Thread t = w.thread;
        if (t != null) {
            final ReentrantLock mainLock = this.mainLock;
            mainLock.lock();
            try {
                // Recheck while holding lock.
                // Back out on ThreadFactory failure or if
                // shut down before lock acquired.
                int rs = runStateOf(ctl.get());

                if (rs < SHUTDOWN ||
                    (rs == SHUTDOWN && firstTask == null)) {
                    if (t.isAlive()) // precheck that t is startable
                        throw new IllegalThreadStateException();
                    workers.add(w);
                    int s = workers.size();
                    if (s > largestPoolSize)
                        largestPoolSize = s;
                    workerAdded = true;
                }
            } finally {
                mainLock.unlock();
            }
            if (workerAdded) {
                t.start();
                workerStarted = true;
            }
        }
    } finally {
        if (! workerStarted)
            addWorkerFailed(w);
    }
    return workerStarted;
}
{% endhighlight %}

这里检查了`Worker`中`thread`属性值是否为空，以防`ThreadFactory`创建线程失败。在修改工作线程集合`workers`的时候需要线程池内部的`mainLock`保护，防止工作线程集合被并发修改。在`mainLock`锁内部又做了一次线程池状态的检查，保证在正确的线程池状态下添加工作线程，即线程池要么是在 **RUNNING** 状态或者 **SHUTDOWN** 状态下，但是`firstTask`必须是`null`（遵循SHUTDOWN状态不能提交任务的原则）。

由于添加工作线程和启动工作线程是独立的两步，所以在成功添加工作线程到`workers`工作线程集合以后，需要将工作线程启动，这里通过局部变量`workerStarted`来记录是否成功启动工作线程，如果启动失败，则需要调用`addWorkerFailed()`回滚已经添加到集合的工作线程：

{% highlight java %}
private void addWorkerFailed(Worker w) {
    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock();
    try {
        if (w != null)
            workers.remove(w);
        decrementWorkerCount();
        tryTerminate();
    } finally {
        mainLock.unlock();
    }
}
{% endhighlight %}

在回滚操作中，需要将之前添加的工作线程从`workers`集合中剔除，并通过`decrementWorkerCount()`递减工作线程数量。这里也调用了`tryTerminate()`以推动线程池状态往终态转换。关于`tryTerminate()`的细节我们在后面关闭线程池的时候再详细分析。



### 预创建

`ThreadPoolExecutor`提供了预创建工作线程的能力。线程池中的`prestartCoreThread()`、`prestartAllCoreThreads()`以及`ensurePrestart()`三个方法提供了预创建工作线程的功能。

{% highlight java %}
public boolean prestartCoreThread() {
    return workerCountOf(ctl.get()) < corePoolSize &&
        addWorker(null, true);
}

void ensurePrestart() {
    int wc = workerCountOf(ctl.get());
    if (wc < corePoolSize)
        addWorker(null, true);
    else if (wc == 0)
        addWorker(null, false);
}

public int prestartAllCoreThreads() {
    int n = 0;
    while (addWorker(null, true))
        ++n;
    return n;
}
{% endhighlight %}

`prestartCoreThread()`和`ensurePrestart()`功能类似，只不过`ensurePrestart()`在`corePoolSize`为0的情况下也会创建一个工作线程。`prestartAllCoreThreads()`会预先创建好所有的核心工作线程。

## 提交任务
线程池`ThreadPoolExecutor`会在多个场景下新增工作线程，比如在提交任务的时候、预创建工作线程的时候、线程因为执行任务抛出异常导致退出的时候，这里我们来分析下提交任务的场景。

{% highlight java %}
public void execute(Runnable command) {
    if (command == null)
        throw new NullPointerException();
    /* 省略注释 */
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) {
        if (addWorker(command, true))
            return;
        c = ctl.get();
    }
    if (isRunning(c) && workQueue.offer(command)) {
        int recheck = ctl.get();
        if (! isRunning(recheck) && remove(command))
            reject(command);
        else if (workerCountOf(recheck) == 0)
            addWorker(null, false);
    }
    else if (!addWorker(command, false))
        reject(command);
}
{% endhighlight %}

线程提交任务的入口在`execute()`方法中，需要被线程池执行的任务最终都需要提交给`execute()`方法执行。在`execute()`方法中主要进行如下操作：

1. 检查线程池当前的工作线程数量是否小于核心线程池数`corePoolSize`，如果少于核心线程数则调用前面分析的`addWorker()`新增工作线程，这个时候会带上提交的任务作为`firstTask`参数传递给创建工作线程的方法。
2. 如果创建工作线程失败（调用`addWorker()`返回false），则尝试将任务放入任务队列中。如果任务可以成功入队，则需要再次检查线程池的状态，判断线程池是否是 **RUNNING** 状态。
  * 如果不是则需要将刚才提交的任务从队列中移除并调用`reject()`方法。在`reject()`方法内部会调用拒绝处理器`RejectedExecutionHandler`处理任务拒绝逻辑，线程池默认的拒绝策略是`defaultHandler`，默认行为是抛出`RejectedExecutionException`异常。
  * 如果线程池的状态正常，则需要再次检查当前线程池是否有工作线程在运行，如果工作线程集合为空，则需要通过`addWorker()`新增工作线程，这里需要注意的是`addWorker()`的`core`参数为false，表示不将创建工作线程的数量限制在核心线程数`corePoolSize`上面而是在最大线程数`maximumPoolSize`上面。
3. 如果任务入队失败，则需要尝试新增工作线程。这个时候就会导致工作线程数量从配置的核心线程数往最大线程数扩增，如果扩增失败则调用`reject()`执行拒绝策略。

所以线程池提交任务的行为还是比较清晰的，可以通过下方的流程图描述：

![流程图](/assets/images/threadpoolexecutor_4.png){:width="70%" hight="70%"}

## 关闭线程池
下面，我们来分析下线程池的关闭逻辑，这里将会介绍如何推动线程池的状态是如何从 **RUNNING** 状态转换到 **TERMINATED** 状态。`ThreadPoolExecutor`提供了两种关闭方式：`shutdown()`和`shutdownNow()`。这两种方式有相似的地方但是也有区别，下面我们通过深入源码来看下两种方式的区别。

### shutdown()

通过调用`shutdown()`关闭的线程池，关闭以后表现的行为就是不能再提交任务给线程池，但是在关闭前已经提交的任务仍旧会被执行。等到任务队列空了以后线程池才会进入关闭流程。下面我们来看下关闭的具体实现原理。

{% highlight java %}
public void shutdown() {
    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock();
    try {
        checkShutdownAccess();
        advanceRunState(SHUTDOWN);
        interruptIdleWorkers();
        onShutdown(); // hook for ScheduledThreadPoolExecutor
    } finally {
        mainLock.unlock();
    }
    tryTerminate();
}
{% endhighlight %}

在执行`shutdown()`逻辑的时候，首先通过`checkShutdownAccess`检查当前执行关闭操作的线程是否有关闭权限，权限检查通过Java的SecurityManager机制实现，检查执行`shutdown()`的线程对线程池中所有工作线程是否都有关闭权限。

{% highlight java %}
private void checkShutdownAccess() {
    SecurityManager security = System.getSecurityManager();
    if (security != null) {
        security.checkPermission(shutdownPerm);
        final ReentrantLock mainLock = this.mainLock;
        mainLock.lock();
        try {
            for (Worker w : workers)
                security.checkAccess(w.thread);
        } finally {
            mainLock.unlock();
        }
    }
}
{% endhighlight %}

当权限检查通过以后，通过执行`advanceRunState(SHUTDOWN)`将线程池的状态跃迁到 **SHUTDOWN** 状态。然后执行`interruptIdleWorkers()`将所有空闲工作线程关闭，在`interruptIdleWorkers()`内部调用了另外的一个版本的`interruptIdleWorkers()`方法来实现真正的关闭空闲线程逻辑：

{% highlight java %}
private void interruptIdleWorkers() {
    interruptIdleWorkers(false);
}

private void interruptIdleWorkers(boolean onlyOne) {
    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock();
    try {
        for (Worker w : workers) {
            Thread t = w.thread;
            if (!t.isInterrupted() && w.tryLock()) {
                try {
                    t.interrupt();
                } catch (SecurityException ignore) {
                } finally {
                    w.unlock();
                }
            }
            if (onlyOne)
                break;
        }
    } finally {
        mainLock.unlock();
    }
}
{% endhighlight %}

`interruptIdleWorkers()`方法通过一个`onlyOne`参数来控制两种空闲工作线程中断模式：快速中断和传播延迟中断。当`onlyOne = false`时进行的是快速中断。

在快速中断模式下，`interruptIdleWorkers()`会通过调用`Thread.interrupt()`方法对所有空闲（idle）线程发送中断命令。之前提到过，所有工作中的线程都需要对`Worker`加锁，所以在这里通过`Worker.tryLock()`来判断被检查的工作线程是否是空闲状态，如果是空闲状态则表示可以加锁，然后发送`interrupt()`命令。在发送中断命令的过程中由于工作线程是处于加锁状态的，所以被中断线程将不能被同时用于执行任务。

{% highlight java %}
private Runnable getTask() {
    for (;;) {
        /* 省略 */
        if (rs >= SHUTDOWN && (rs >= STOP || workQueue.isEmpty())) {
            decrementWorkerCount();
            return null;
        }
        /* 省略 */
        try {
            Runnable r = timed ?
                workQueue.poll(keepAliveTime, TimeUnit.NANOSECONDS) :
                workQueue.take();
            if (r != null)
                return r;
            timedOut = true;
        } catch (InterruptedException retry) {
            timedOut = false;
        }
    }
}

final void runWorker(Worker w) {
    w.unlock(); // allow interrupts
    boolean completedAbruptly = true;
    try {
        while (task != null || (task = getTask()) != null) {
            w.lock();
            /* 执行任务的逻辑 */
            } finally {
                task = null;
                w.completedTasks++;
                w.unlock();
            }
        }
        completedAbruptly = false;
    } finally {
        processWorkerExit(w, completedAbruptly);
    }
}
{% endhighlight %}

回顾下前面介绍[任务执行](#任务执行)那一节中分析`runWorker()`方法的部分，当`getTask()`方法返回`null`以后，`runWorker()`方法会执行`processWorkerExit()`方法处理工作线程退出逻辑。

我们之前分析过`processWorkerExit()`的逻辑，但是有一个点没有讲，那就是`tryTerminate()`方法。之前在分析线程池的代码的时候多次遇到`tryTerminate()`方法的调用，这个方法很重要，是保证线程池中所有工作线程都可以被关闭的重要一环。

大家思考下刚才在`interruptIdleWorkers()`中分析的快速中断模式，会发现通过快速中断模式关闭的线程池，只会对空闲的工作线程有效，而对于正在执行任务的工作线程是不会产生作用的。那这部分工作中的线程如何被关闭呢？这就需要用到下面介绍的传播延迟中断模式，而这种中断方式需要`runWorker()`和`tryTerminate()`紧密合作才能做到。

{% highlight java %}
final void tryTerminate() {
    for (;;) {
        int c = ctl.get();
        if (isRunning(c) ||
            runStateAtLeast(c, TIDYING) ||
            (runStateOf(c) == SHUTDOWN && ! workQueue.isEmpty()))
            return;
        if (workerCountOf(c) != 0) { // Eligible to terminate
            interruptIdleWorkers(ONLY_ONE);
            return;
        }

        final ReentrantLock mainLock = this.mainLock;
        mainLock.lock();
        try {
            if (ctl.compareAndSet(c, ctlOf(TIDYING, 0))) {
                try {
                    terminated();
                } finally {
                    ctl.set(ctlOf(TERMINATED, 0));
                    termination.signalAll();
                }
                return;
            }
        } finally {
            mainLock.unlock();
        }
        // else retry on failed CAS
    }
}
{% endhighlight %}

在`tryTerminate()`中，首先检查当前线程池是否满足进入 **TERMINATED** 状态的条件，如果线程池当前处于 **RUNNING** 状态或者已经进入了终止状态或者当前处于 **SHUTDOWN** 状态，但是任务队列不为空，则不执行终止逻辑。如果满足终止条件，则通过`workerCountOf(c) != 0`检查当前线程池中工作线程集合是否为空，如果工作线程集合不为空，则执行`interruptIdleWorkers(ONLY_ONE)`逻辑，之前分析`interruptIdleWorkers()`方法的时候已经分析过`onlyOne = false`的快速中断模式，现在我们来看下`onlyOne = true`的传播延迟中断模式。

在`onlyOne = true`的传播中断模式下，`interruptIdleWorkers()`只会中断工作线程集合中的任意一个空闲的工作线程，而不是对所有空闲的工作线程都触发中断请求。而这个被中断的工作线程会按照我们在快速中断模式中分析过的行为那样：在退出时调用`processWorkerExit()`逻辑，而在`processWorkerExit()`逻辑内部又会触发`tryTerminate()`逻辑，在`tryTerminate()`的逻辑中，有会触发`interruptIdleWorkers()`的传播延迟中断模式。这个过程会不断重复，保证中断命令在工作线程集合中得到传播。

这种工作机制，可以保证即使当前工作线程集合中存在非空闲的工作线程，在未来某个时间点当它变成空闲线程的时候中断命令还是会传递到这个工作线程中，最终集合中的所有工作线程都退出。

{% highlight java %}
private void processWorkerExit(Worker w, boolean completedAbruptly) {
    /* 省略 */
    mainLock.lock();
    try {
        completedTaskCount += w.completedTasks;
        workers.remove(w);
    } finally {
        mainLock.unlock();
    }
    tryTerminate();
    /* 省略 */
}
{% endhighlight %}

由于在`processWorkerExit()`中处理工作线程退出逻辑的时候是先将工作线程从`workers`集合中删除，然后再执行`tryTerminate()`逻辑，所以在`interruptIdleWorkers()`中选择下一个中断传播对象的时候，中断命令不会重复发到同一个正在执行退出逻辑的工作线程上，保证了传播中的中断命令不会丢失。

![中断传播](/assets/images/threadpoolexecutor_5.png){:width="70%" hight="70%"}

当最后一个工作线程执行`tryTerminate()`的时候，在通过`workerCountOf(c) != 0`检查线程池工作线程集合是否为空的时候会返回`true`，这个时候才真正开始执行下面的终止逻辑：

{% highlight java %}
final void tryTerminate() {
    for (;;) {
        /* 省略 */
        final ReentrantLock mainLock = this.mainLock;
        mainLock.lock();
        try {
            if (ctl.compareAndSet(c, ctlOf(TIDYING, 0))) {
                try {
                    terminated();
                } finally {
                    ctl.set(ctlOf(TERMINATED, 0));
                    termination.signalAll();
                }
                return;
            }
        } finally {
            mainLock.unlock();
        }
        // else retry on failed CAS
    }
}
{% endhighlight %}

在这段终止逻辑中，线程池的状态会先变成 **TIDYING**，然后执行终止钩子（hook）方法`terminated()`，这里用了CAS操作来更新 **TIDYING** 状态是为了防止出现并发更新。当`terminated()`方法返回以后线程池的状态就进入终态 **TERMINATED**，在进入终态以后会调用`termination.signalAll()`通知所有阻塞在`awaitTermination()`方法上的应用代码。

回到`shutdown()`的代码，在执行完`interruptIdleWorkers()`以后，调用`onShutdown()`钩子（hook）方法回调用户自定义的逻辑，最后执行`tryTerminate()`尝试将线程池推向终态。以上就是`shutdown()`关闭线程池的流程，下面我们来看下`shutdownNow()`的逻辑。

### shutdownNow()
通过`shutdownNow()`关闭线程池和`shutdown()`类似，区别在于`shutdownNow()`在关闭线程池的时候会中断所有正在执行的任务，并且清空还在队列中等待执行的任务。

{% highlight java %}
public List<Runnable> shutdownNow() {
    List<Runnable> tasks;
    final ReentrantLock mainLock = this.mainLock;
    mainLock.lock();
    try {
        checkShutdownAccess();
        advanceRunState(STOP);
        interruptWorkers();
        tasks = drainQueue();
    } finally {
        mainLock.unlock();
    }
    tryTerminate();
    return tasks;
}
{% endhighlight %}

和`shutdown()`一样，第一步先检查权限，然后将线程池的状态跃迁到 **STOP**。更改完状态以后调用`interruptWorkers()`，在`interruptWorkers()`方法中会对工作线程集合中的所有工作线程调用`w.interruptIfStarted()`以中断所有已经启动的工作线程。然后通过`drainQueue()`从任务队列中取出所有未被执行的任务，最后执行`tryTerminate()`推动线程池进入终态。而未被执行的任务列表会被作为返回值返回给应用程序。

## 动态调整
除了可以在创建线程池的时候设置线程池的配置参数，还可以在运行时动态调整线程池的配置。下面是`ThreadPoolExecutor`提供的一些动态调整API，供开发者在线程池启动以后动态调整参数：

{% highlight java %}
public void setCorePoolSize(int corePoolSize);
public void setRejectedExecutionHandler(RejectedExecutionHandler handler);
public void setThreadFactory(ThreadFactory threadFactory);
public boolean allowsCoreThreadTimeOut(boolean value);
public void setMaximumPoolSize(int maximumPoolSize);
public void setKeepAliveTime(long time, TimeUnit unit);
{% endhighlight %}

对于`setRejectedExecutionHandler()`和`setThreadFactory()`线程池的实现比较简单。线程池在实现的时候对`handler`和`threadFactory`加了`volatile`修饰符，保证了内存的可见性，所以直接修改对应的配置项的值就可以生效。对于调整线程池的大小和线程存活时间`keepAliveTime`，由于需要触发线程池内部进行调整，所以相对麻烦点。

{% highlight java %}
public void setCorePoolSize(int corePoolSize) {
    if (corePoolSize < 0)
        throw new IllegalArgumentException();
    int delta = corePoolSize - this.corePoolSize;
    this.corePoolSize = corePoolSize;
    if (workerCountOf(ctl.get()) > corePoolSize)
        interruptIdleWorkers();
    else if (delta > 0) {
        // We don't really know how many new threads are "needed".
        // As a heuristic, prestart enough new workers (up to new
        // core size) to handle the current number of tasks in
        // queue, but stop if queue becomes empty while doing so.
        int k = Math.min(delta, workQueue.size());
        while (k-- > 0 && addWorker(null, true)) {
            if (workQueue.isEmpty())
                break;
        }
    }
}
{% endhighlight %}

在动态调整核心线程池数量`corePoolSize`的时候，如果当前线程池工作线程数量大于新设置的值，则通过`interruptIdleWorkers()`将空闲的工作线程回收。如果设置的新的核心工作线程数量大于原先的核心线程数，则基于当前任务队列中任务的数量和新旧核心工作线程数量之间的差额`Math.min(delta, workQueue.size())`来进行调整，在调整的时候通过`while`循环逐步新增工作线程，如果在新增工作线程的过程中任务队列为空，则停止新增。

{% highlight java %}
public void allowCoreThreadTimeOut(boolean value) {
    if (value && keepAliveTime <= 0)
        throw new IllegalArgumentException("Core threads must have nonzero keep alive times");
    if (value != allowCoreThreadTimeOut) {
        allowCoreThreadTimeOut = value;
        if (value)
            interruptIdleWorkers();
    }
}
{% endhighlight %}

`allowCoreThreadTimeOut()`方法的逻辑如上所示，如果新的设置值和原先的`allowCoreThreadTimeOut`值不一样，则修改完以后调用`interruptIdleWorkers()`来触发线程池内部的调整，利用的就是`interruptIdleWorkers()`内部的扩散机制，使线程池内部达到平衡。`setKeepAliveTime()`和`setMaximumPoolSize()`的实现机制也类似，也是依托于`interruptIdleWorkers()`来实现内部调整，读者可以自行看源码分析。下面，我们来分析下线程池是如何管理任务队列中的任务的。

## 任务管理
线程池`ThreadPoolExecutor`内部通过`BlockingQueue`来存储排队的任务，线程池提供了几个API供开发者管理在任务队列`workQueue`中的任务。

{% highlight java %}
public BlockingQueue<Runnable> getQueue();
public boolean remove(Runnable task);
public void purge();
{% endhighlight %}

方法`purge()`比较特殊，它只支持`Future`类型的任务，所以`purge()`操作需要`Future`特性的支持，`purge()`作用是将任务队列中所有已经取消的任务移除。

### FutureTask
`Future`是对一个异步计算结果的抽象，通过`Future`对象可以对计算任务进行控制，比如获取计算结果、取消计算任务等等。`Future`提供了一系列和任务交互的API：

{% highlight java %}
public interface Future<V> {
    boolean cancel(boolean mayInterruptIfRunning);
    boolean isCancelled();
    boolean isDone();
    V get() throws InterruptedException, ExecutionException;
    V get(long timeout, TimeUnit unit) throws InterruptedException, ExecutionException, TimeoutException;
}
{% endhighlight %}

JUC中提供了一个`Future`的基础实现`FutureTask`，可以配合`ThreadPoolExecutor`一起完成计算任务的控制和计算结果的获取。

`ThreadPoolExecutor`继承的抽象类`AbstractExecutorService`中提供了普通`Runnable`和`Callable`任务对象到`FutureTask`对象的转换：

{% highlight java %}
public abstract class AbstractExecutorService implements ExecutorService {
  /* 省略 */
  protected <T> RunnableFuture<T> newTaskFor(Runnable runnable, T value) {
      return new FutureTask<T>(runnable, value);
  }
  
  protected <T> RunnableFuture<T> newTaskFor(Callable<T> callable) {
      return new FutureTask<T>(callable);
  }

  /* 省略 */
}
{% endhighlight %}

在`AbstractExecutorService`中通过方法`newTaskFor()`将任务对象转换成`FutureTask`对象。我们在使用线程池的`submit()`方法的时候，在`submit()`方法内部会调用`newTaskFor()`完成任务对象的转换工作，然后将`FutureTask`对象通过`execute()`方法传递都线程池中，由工作线程负责执行，通过`Future`对象打通线程池内部工作线程和应用程序线程之间的桥梁，应用可以通过`Future`对象管理异步计算任务并获取异步计算结果。

{% highlight java %}
public Future<?> submit(Runnable task) {
    if (task == null) throw new NullPointerException();
    RunnableFuture<Void> ftask = newTaskFor(task, null);
    execute(ftask);
    return ftask;
}
{% endhighlight %}

### invokeAll()
`invokeAll()`用于同时执行多个给定的任务，当所有任务都完成以后返回这些任务的`Future`对象列表。`invokeAll()`支持支持两个实现版本：超时版本和非超时版本。

{% highlight java %}
public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks)
    throws InterruptedException {
    if (tasks == null)
        throw new NullPointerException();
    ArrayList<Future<T>> futures = new ArrayList<Future<T>>(tasks.size());
    boolean done = false;
    try {
        for (Callable<T> t : tasks) {
            RunnableFuture<T> f = newTaskFor(t);
            futures.add(f);
            execute(f);
        }
        for (int i = 0, size = futures.size(); i < size; i++) {
            Future<T> f = futures.get(i);
            if (!f.isDone()) {
                try {
                    f.get();
                } catch (CancellationException ignore) {
                } catch (ExecutionException ignore) {
                }
            }
        }
        done = true;
        return futures;
    } finally {
        if (!done)
            for (int i = 0, size = futures.size(); i < size; i++)
                futures.get(i).cancel(true);
    }
}
{% endhighlight %}

在非超时版本中，`invokeAll()`将所有提交的任务转换成对应的`FutureTask`对象，然后调用`execute()`方法将任务逐个提交给线程池执行，通过`Future`对象等待所有任务执行完成，如果所有任务都执行完成则返回`Future`对象列表。

{% highlight java %}
public <T> List<Future<T>> invokeAll(Collection<? extends Callable<T>> tasks,
                                     long timeout, TimeUnit unit)
    throws InterruptedException {
    if (tasks == null)
        throw new NullPointerException();
    long nanos = unit.toNanos(timeout);
    ArrayList<Future<T>> futures = new ArrayList<Future<T>>(tasks.size());
    boolean done = false;
    try {
        for (Callable<T> t : tasks)
            futures.add(newTaskFor(t));

        final long deadline = System.nanoTime() + nanos;
        final int size = futures.size();

        // Interleave time checks and calls to execute in case
        // executor doesn't have any/much parallelism.
        for (int i = 0; i < size; i++) {
            execute((Runnable)futures.get(i));
            nanos = deadline - System.nanoTime();
            if (nanos <= 0L)
                return futures;
        }

        for (int i = 0; i < size; i++) {
            Future<T> f = futures.get(i);
            if (!f.isDone()) {
                if (nanos <= 0L)
                    return futures;
                try {
                    f.get(nanos, TimeUnit.NANOSECONDS);
                } catch (CancellationException ignore) {
                } catch (ExecutionException ignore) {
                } catch (TimeoutException toe) {
                    return futures;
                }
                nanos = deadline - System.nanoTime();
            }
        }
        done = true;
        return futures;
    } finally {
        if (!done)
            for (int i = 0, size = futures.size(); i < size; i++)
                futures.get(i).cancel(true);
    }
}
{% endhighlight %}

超时版本的`invokeAll()`的实现方式和非超时版本类似，只是加了超时时间的限制。如果超时时间到了任务还没有执行完也直接返回。超时版本中，在提交任务给线程池的循环中，会通过`nanos = deadline - System.nanoTime()`检查超时时间是否达到，如果达到则跳过后面未执行的任务直接返回，在返回前需要在`finally`语句中取消那些未完成的任务。由于这里的计时策略是每提交一个任务检查一次，所以当线程池超负荷运行的时候，不同的线程池拒绝会对超时产生影响。

### invokeAny()
`invokeAny()`的语义要求只要提交的任意一个任务执行完成就返回。在`invokeAny()`内部通过将任务提交给`ExecutorCompletionService`来实现执行任务的工作。

`ExecutorCompletionService`是对`ThreadPoolExecutor`的封装，提供了一个队列来存储已经完成的任务，应用程序可以通过轮询队列获取已经完成的任务。

`invokeAny()`和`invokeAll()`一样也支持两个版本的实现，不过`invokeAny()`的两个实现在内部都委托给了`doInvokeAny()`：

{% highlight java %}
private <T> T doInvokeAny(Collection<? extends Callable<T>> tasks,
                          boolean timed, long nanos)
    throws InterruptedException, ExecutionException, TimeoutException {
    if (tasks == null)
        throw new NullPointerException();
    int ntasks = tasks.size();
    if (ntasks == 0)
        throw new IllegalArgumentException();
    ArrayList<Future<T>> futures = new ArrayList<Future<T>>(ntasks);
    ExecutorCompletionService<T> ecs =
        new ExecutorCompletionService<T>(this);

    // For efficiency, especially in executors with limited
    // parallelism, check to see if previously submitted tasks are
    // done before submitting more of them. This interleaving
    // plus the exception mechanics account for messiness of main
    // loop.

    try {
        // Record exceptions so that if we fail to obtain any
        // result, we can throw the last exception we got.
        ExecutionException ee = null;
        final long deadline = timed ? System.nanoTime() + nanos : 0L;
        Iterator<? extends Callable<T>> it = tasks.iterator();

        // Start one task for sure; the rest incrementally
        futures.add(ecs.submit(it.next()));
        --ntasks;
        int active = 1;

        for (;;) {
            Future<T> f = ecs.poll();
            if (f == null) {
                if (ntasks > 0) {
                    --ntasks;
                    futures.add(ecs.submit(it.next()));
                    ++active;
                }
                else if (active == 0)
                    break;
                else if (timed) {
                    f = ecs.poll(nanos, TimeUnit.NANOSECONDS);
                    if (f == null)
                        throw new TimeoutException();
                    nanos = deadline - System.nanoTime();
                }
                else
                    f = ecs.take();
            }
            if (f != null) {
                --active;
                try {
                    return f.get();
                } catch (ExecutionException eex) {
                    ee = eex;
                } catch (RuntimeException rex) {
                    ee = new ExecutionException(rex);
                }
            }
        }

        if (ee == null)
            ee = new ExecutionException();
        throw ee;

    } finally {
        for (int i = 0, size = futures.size(); i < size; i++)
            futures.get(i).cancel(true);
    }
}
{% endhighlight %}

在`doInvokeAny()`的实现中，首先会将一个任务提交到`ExecutorCompletionService`中，然后开始轮询任务完成队列，如果其中任何一个任务成功执行完成，则停止提交任务，否则逐个提交任务，直到提交的任务中有一个成功执行完成或者都失败，如果失败则抛出`ExecutionException`异常。对于超时版本，当超时到达的时候如果仍旧没有任务完成，则抛出`TimeoutException`异常。在返回前会执行`finally`语句块，取消所有正在执行中或者等待执行的任务。

## 总结
本文分析了Java并发包中线程池的实现，分析了线程池的实现实现原理。介绍了线程池是如何进行容量管理、线程池如何执行任务、`FutureTask`的实现机制以及线程池关闭的过程和细节。
