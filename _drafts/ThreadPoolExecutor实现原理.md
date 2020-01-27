---
layout: post
title: ThreadPoolExecutor实现原理
date: "2019-10-02 20:44:00 +0800"
categories: multithread
tags: java multithread concurrency
published: true
---

## 前言

在Java中，日常大家用的最多的线程池就是`ThreadPoolExecutor`，它是由 **Doug Lea** 实现并在JDK 1.5中跟随`java.util.concurrency`并发包被引入。本文将通过源码带大家一窥`ThreadPoolExecutor`的实现原理，了解线程池的设计和实现。

*本文假设读者已经对线程池是的概念有所了解，并且有Java线程池的相关使用经验。文中引用的源码基于JDK 8。*

## 线程池结构

首先，在深入了解`ThreadPoolExecutor`的实现之前，我们先来看下它的结构。

### 类继承关系

在类继承体系上，`ThreadPoolExecutor`继承了`AbstractExecutorService`，而`AbstractExecutorService`实现了`ExecutorService`接口，`ExecutorService`继承了`Executor`接口。

![thread_pool_executor类图](/assets/images/threadpoolexecutor_0.png){:width="25%" hight="25%"}

`Executor`接口中只定了一个`execute()`方法，它是线程池执行任务的入口。而我们平时使用的`submit()`方法是由`ExecutorService`定义的，本质上也是调用了`Executor`中的`execute()`方法，只不过对执行的`Runnable`对象进行了封装，封装成了`FutureTask`，并返回了一个`Future`对象，为程序员提供了控制任务入口。

在`ExecutorService`接口中提供了线程池的管理方法，包括`shutdown()`和`shutdownNow()`，以及一系列的任务提交方法`submit()`。

### 内部结构
在`ThreadPoolExecutor`中定义了一个任务队列`workerQueue`以及一个工作线程集合`workers`。通过实现一个 **生产者-消费者** 模型来处理提交给线程池的任务。线程池通过管理`workers`中的工作线程来是实现线程池的伸缩，通过`workerQueue`实现任务管理。

![生产者消费者模型](/assets/images/threadpoolexecutor_1.png){:width="55%" hight="55%"}

## 工作线程
在`ThreadPoolExecutor`中，工作线程通过`Worker`来抽象，一个Worker表示一个在线程池中实际处理任务的工作单元。`Worker`实现了`Runnable`接口，并且继承了`AbstractQueuedSynchronizer`类。

`Worker`继承`AbstractQueuedSynchronizer`类的目的是为了实现一个互斥锁，所以`Worker`本身就是一个互斥锁，它提供了`lock()`、`tryLock()`、`unlock()`以及`isLocked()`方法。

{% highlight java %}
public void lock()        { acquire(1); }
public boolean tryLock()  { return tryAcquire(1); }
public void unlock()      { release(1); }
public boolean isLocked() { return isHeldExclusively(); }
{% endhighlight %}

线程池`ThreadPoolExecutor`将Worker看做是一种计算资源，当worker在工作线程池中的`workers`集合中被取出用来执行任务的时候，需要先获取这个worker，获取的过程实际就是一个加锁的过程，只不过这个锁是加在worker上面的，防止同一个worker被多个线程共同使用。由于在工作中的worker被加上了锁，所以可以通过判断worker是否加锁来判断worker是否处于空闲（idle）状态。

在`Worker`中定义了三个成员变量：`thread`、`firstTask`、`completedTasks`。分别表示worker对应的线程、第一个被执行的任务（可能为空）以及这个worker在存活期间执行任务的总数（为了统计线程池的执行任务数而加的一个字段）。

`Worker`具体执行任务是在`run()`方法中执行的，`run()`方法中执行了`ThreadPoolExecutor`的`runWorker()`方法做具体了任务处理逻辑。在介绍任务处理的逻辑之前，我们先看下线程池是如何表示状态的。

## 线程池状态
线程池`ThreadPoolExecutor`在记录线程池的状态和当前线程池中工作线程数量的时候没有使用两个单独的字段表示，而是通过一个`int`类型的将这两部分信息打包存储（pack）在`int`的31位（bit）中。

![pack](/assets/images/threadpoolexecutor_2.png){:width="55%" hight="55%"}

在`int`的32位中，除了最高位为0以外，剩下的31位中，高2位表示线程池的状态，剩下的29位表示当前线程池中工作线程的数量，表示范围为$0$ ~ $2^{29} - 1$，最大容量通过静态变量`CAPACITY`表示。

线程池`ThreadPoolExecutor`中状态通过2位（bit）表示，在线程池中定义了5个状态：`RUNNING`、`SHUTDOWN`、`STOP`、`TIDYING`和`TERMINATED`。

RUNNING
: 线程池正常的状态，在 **RUNNING** 状态下线程池接受新的任务并处理任务队列中的任务。

SHUTDOWN
: 调用`shutdown()`方法会进入 **SHUTDOWN** 状态。在 **SHUTDOWN** 状态下，线程池不接受新的任务，但是会继续执行任务队列中之前加入的任务。

STOP
: 调用`shutdownNow()`会进入 **STOP** 状态。在 **STOP** 状态下线程池既不接受新的任务，也不处理已经在队列中的任务。对于还在执行的任务，线程池会发起中断请求来中断正在执行的任务。

TIDYING
: 当线程池中的所有执行任务的工作线程都已经终止，并且工作线程集合为空的时候，进入 **TIDYING** 状态。

TERMINATED
: 当线程池执行完`terminated()`钩子方法以后，线程池进入终态 **TERMINATED** 。

下面是线程池完整的状态转换图：

![状态转换图](/assets/images/threadpoolexecutor_3.png){:width="70%" hight="70%"}

## 任务执行
线程池`ThreadPoolExecutor`通过队列解耦了任务执行和任务添加，我们先来分析下线程池是如何执行任务的。前面介绍`Worker`的时候提到了，工作线程在实际处理任务的时候是在`run()`方法中执行的：

{% highlight java %}
/** Delegates main run loop to outer runWorker  */
public void run() {
    runWorker(this);
}
{% endhighlight %}

在`run()`方法中，`Worker`将任务处理的细节委托给了`ThreadPoolExecutor`的`runWorker()`方法。下面我们来分析`runWorker()`的逻辑：

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

`runWorker()`的逻辑主要是一个`while`循环，在这个while循环中不断通过`getTask()`从任务队列中取出任务以后执行任务的`run()`方法。如果`getTask()`返回`null`值，则退出循环并关闭工作线程。

在`while`循环内部，开始执行具体任务的逻辑之前，先调用`Worker`的`lock()`方法锁住工作worker，这样在worker执行任务的过程中不会被外部中断和干扰，同时如果worker处于锁定状态，也表示当前worker不处于空闲状态。然后在具体执行任务之前，先检查当前线程池的状态是否是可运行的：

{% highlight java %}
if ((runStateAtLeast(ctl.get(), STOP) ||
     (Thread.interrupted() &&
      runStateAtLeast(ctl.get(), STOP))) &&
    !wt.isInterrupted())
    wt.interrupt();
{% endhighlight %}

在这段逻辑里面，检查当前工作线程的中断状态。线程池需要保证工作线程的中断标记被正确的设置：
1. 如果线程池处于 **STOP** 状态，则必须保证工作线程的中断标记被设置
2. 如果线程池不处于 **STOP** 状态，则必须保证工作线程的中断标记不被设置

所以为了保证上面两个点，`runStateAtLeast(ctl.get(), STOP)`用于检测第二个情况，而在`Thread.interrupted() && runStateAtLeast(ctl.get(), STOP)`中，进行二次检测是为了防止在第一次检测的时候，如果线程池状态不是 **STOP** 状态，如果调用`Thread.interrupted()`清空线程池状态标记的时候，线程池状态变成了 **STOP** 状态，可能会存在竞态条件，所以需要再次检测一遍线程池的状态。如果满足上面的第一点，则调用`wt.interrupt()`中断当前的工作线程。

检测完中断标记以后，在开始执行具体的任务之前有一个`beforeExecute()`钩子方法，提供给实现者实现需要的前置逻辑，然后就是具体的任务执行逻辑`task.run()`，最后执行完成以后在`finally`中执行后置逻辑的钩子方法`afterExecute()`。在执行完一个任务以后，需要更新`completedTasks`统计指标并释放worker的锁。

## 容量管理
上面是任务执行的主流程，那么线程池是如何管理线程池的容量，对线程池进行扩容和缩容呢？

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

在`getTask()`的`for`循环中首先检查线程池的状态，如果线程池状态是`SHUTDOWN`并且线程池中任务队列为空，则递减线程池中工作线程数量并返回`null`，`null`值对于`runWorker()`来说有特殊用途，用于通知获取任务的工作线程结束并退出。`ThreadPoolExecutor`通过`getTask()`的返回值来控制线程池的收缩：

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

这里检查`allowCoreThreadTimeOut`的值是否为`true`，如果为`true`则表示允许线程池的核心线程被回收；或者如果当前线程数超过了核心线程数，则表示需要处理工作线程回收的情况，所以将是否需要回收线程的标记记录在`timed`中，通过判断`(wc > maximumPoolSize || (timed && timedOut)) && (wc > 1 || workQueue.isEmpty())`是否为`true`来缩容。其中`timeOut`字段是基于下面`workQueue.poll()`的返回值判断的，如果返回值是`null`则表示在`keepAliveTime`受限时间内没有取到任务，触发了线程池的缩容逻辑。

从这部分逻辑可以看出，`ThreadPoolExecutor`的`keepAliveTime`缩容机制依赖于阻塞队列的超时特性，而不是独立维护工作线程的空闲超时时间。一旦`getTask()`返回`null`则在`runWorker()`中需要执行`processWorkerExit()`方法处理工作线程退出的逻辑。

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

`processWorkerExit()`接受一个`Worker`对象和一个`completedAbruptly`参数，`completedAbruptly`参数表示工作线程是否是异常退出（由于执行用户提交的任务抛出异常而导致工作线程退出）的，如果工作线程是由于业务异常退出，则通过`addWorker()`新增一个工作线程；否则通过检查当前线程池的配置，判断是否需要新增工作线程。

在退出当前工作线程的时候，需要触发一次`tryTerminate()`逻辑。`tryTerminate()`的作用是推动线程池进入 **TERMINATED** 状态。

### 扩容

线程池通过`addWorker()`进行扩容，在`addWorker()`中接受两个参数，`firstTask`表示第一个被执行的任务，用于在首次创建worker的时候提供第一个被执行的任务，第二个参数`core`表示是否创建核心线程。

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
在创建worker之前，在`addWorker()`中需要先检查线程池的状态和当前线程任务队列中任务的数量以确定是否可以真的新增worker。上面的代码检查四个点：

1. 如果线程池的状态是TIDYING或TERMINATED状态则不能再新增worker
2. 如果线程池存于SHUTDOWN状态并且任务队列为空则不能再新增worker
3. 如果线程池处于SHUTDOWN状态下`firstTask`不为空则不能再新增worker。在线程池中只有在提交任务的时候扩容才会出现入参`firstTask`不为空的情况，但是在SHUTDOWN状态下线程池不能再添加任务，所以不能因为为了添加任务而新增worker。
4. 检查线程池当前的容量，如果容量超过`CAPACITY`的限制或者超过核定容量则不能再新增worker。这里的核定容量基于入参`core`判断，如果`core`为true，则核定容量是`corePoolSize`的值，否则就是设置的最大线程池数`maximumPoolSize`。

如果上面四个条件都满足，则先进行容量值的递增，在增大容量值的时候通过`compareAndIncrementWorkerCount`进行CAS操作来处理并发扩容的情况。代码中的二层`for`循环以及一系列的`break`、`continue`跳转语句也都是基于CAS的方式来解决并发扩容的问题。

当容量和状态检查都通过以后，就可以开始真正的扩容操作了：

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

创建worker的逻辑比较简单，这里检查了`Worker`中`thread`属性值是否为空，以防止`ThreadFactory`创建线程失败。在修改工作线程集合`workers`的时候需要线程池内部的`mainLock`保护，防止被并发修改。`mainLock`主要用于在线程池内部保护工作线程集合、状态和一些核心参数的并发更改。在`mainLock`锁内部又做了一次线程池状态的检查，保证在正确的线程池状态下添加worker，即线程池要么是在RUNNING状态或者在SHUTDOWN状态下，但是firstTask必须是`null`（遵循SHUTDOWN状态不能提交任务的原则）。

由于添加工作线程和启动工作线程是独立的两步，所以在成功添加worker到`workers`工作线程集合以后，需要将worker内部的线程启动，这里通过局部变量`workerStarted`来记录是否成功启动工作线程，如果启动失败，则需要调用`addWorkerFailed()`回滚已经添加的worker：

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

在回滚操作中，将之前添加的worker从`workers`集合中剔除，并通过`decrementWorkerCount()`递减工作线程数量。这里也调用了`tryTerminate()`以推动线程池状态往终态转换。关于`tryTerminate()`的细节我们在后面关闭线程池的时候再详细分析。

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

`prestartCoreThread()`和`ensurePrestart()`功能类似，只不过`ensurePrestart()`在`corePoolSize`为0的情况下也会创建一个工作线程。`prestartAllCoreThreads()`会预先创建好所有的核心线程。

## 提交任务
线程池`ThreadPoolExecutor`会在多个场景下新增工作线程，比如在提交任务的时候、预创建工作线程的时候、线程因为执行任务抛出异常导致退出的时候，这里我们来分析下主流程里扩容的场景，也就是提交任务的场景。

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

线程提交任务的入口在`execute()`方法，需要被线程池执行的任务最终都需要提交给`execute()`方法执行。在`execute()`方法中主要进行如下操作：

1. 检查线程池当前的工作现场数量是否小于核心线程池数`corePoolSize`，如果少于核心线程数则调用前面分析的`addWorker()`新增工作线程，这个时候会带上提交的任务作为`firstTask`参数传递给创建工作线程的方法。
2. 如果创建工作线程失败（调用`addWorker()`返回false），则尝试将任务放入任务队列中。如果任务可以成功入队，则需要再次检查线程池的状态，判断线程池是否是RUNNING状态。
  * 如果不是则需要将刚才提交的任务从队列中移除并调用`reject()`方法。在`reject()`方法内部则会调用拒绝处理器`RejectedExecutionHandler`处理任务拒绝逻辑，线程池默认的拒绝策略是`defaultHandler`，默认行为是抛出`RejectedExecutionException`异常。
  * 如果线程池的状态正常，则再次检查当前线程池是否有工作线程在运行，如果工作线程集合为空，则需要通过`addWorker()`新增工作线程，这里需要注意的是`addWorker()`的`core`参数为false，表示不将创建工作线程的数量限制在核心线程数`corePoolSize`上面而是在最大线程数`maximumPoolSize`上面。
3. 如果任务入队失败，则需要尝试新增工作线程。这个时候就会导致工作线程数量从配置的核心线程数往最大线程数扩增，如果扩增失败则调用`reject()`执行拒绝策略。

所以线程池提交任务的行为还是比较清晰的，可以通过下方的流程图描述：

![流程图](/assets/images/threadpoolexecutor_4.png){:width="70%" hight="70%"}

## 关闭线程池
下面，我们来分析下线程池的关闭逻辑，这里将会介绍如何推动线程池的状态是如何从 **RUNNING** 状态转换到 **TERMINATED** 状态。`ThreadPoolExecutor`提供了两种关闭方式：`shutdown()`和`shutdownNow()`。这两种方式有相似的地方，但是也有区别，下面我们通过深入源码来看下两种方式的区别。

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

在执行`shutdown()`逻辑的时候，首先通过`checkShutdownAccess`检查当前执行关闭操作的线程是否有关闭权限，这块通过Java的SecurityManager机制实现，检查执行`shutdown`的线程对线程池中所有工作线程是否都有关闭权限。

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

在快速中断模式下，`interruptIdleWorkers()`会通过调用`Thread.interrupt()`方法对所有空闲（idle）线程发送中断命令。之前提到过，所有工作中的线程都需要对`Worker`加锁，所以在这里通过`Worker.tryLock()`来判断被检查的工作线程是否是空闲状态，如果是空闲状态则表示可以加锁，然后发送`interrupt()`命令。在发送中断命令的过中由于工作线程是处于加锁状态的，所以被中断线程将不能被同时用于执行任务。

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

回顾下之前介绍[任务执行](#任务执行)那一节中分析的`runWorker()`方法，当任务队列为空的时候，工作线程在`for`循环中会阻塞在`getTask()`方法上等待获取任务，如果工作线程在阻塞状态下被中断或者在设置了中断标记的情况下进入阻塞状态，该线程将会抛出`InterruptedException`异常，这个时候`getTask()`在捕获异常以后再次循环检查线程池状态。如果发现线程池状态已经变成了 **SHUTDOWN** 则还需要检查当前任务队列中是否有任务：

1. 如果任务队列不为空，表示当前线程池中还有任务没有执行完，需要继续执行，所以这个线程会继续留下来执行剩下的任务（这种情况一般是在并发状态下突然插入了一个任务到任务队列中的情况）。
2. 如果任务队列确实为空，`getTask()`会立马返回`null`值告知调用者`runWorker()`工作线程可以退出了，`runWorker()`会执行`processWorkerExit()`退出逻辑。

我们在之前分析`runWorker()`的时候分析过`processWorkerExit()`的逻辑，但是有一个点没有讲，那就是`tryTerminate()`方法。我们之前在分析线程池的代码的时候多次遇到`tryTerminate()`方法的调用，这个方法很重要，是保证线程池中的所有工作线程都可以被关闭的重要一环。大家思考下刚才在`interruptIdleWorkers()`中分析的快速中断模式，会发现通过快速中断模式关闭的线程池，只会对空闲的工作线程有效，而对于正在执行任务的工作线程是不会产生作用的。那这部分工作中的线程如何被关闭呢？这就需要用到下面介绍的传播延迟中断模式，而这种中断方式需要`runWorker()`和`tryTerminate()`紧密合作才能做到。

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

在`tryTerminate()`中，首先检查当前线程池是否满足进入 **TERMINATED** 状态的条件，如果线程池当前处于 **RUNNING** 状态或者已经进入了终止状态或者当前处于 **SHUTDOWN** 状态，但是任务队列不为空，则不执行终止逻辑。如果满足终止条件，则通过`workerCountOf(c) != 0`检查当前线程池中工作线程集合是否为空，如果工作线程集合不为空，则执行`interruptIdleWorkers(ONLY_ONE)`逻辑，`interruptIdleWorkers()`的逻辑之前已经分析过`onlyOne = false`的快速中断模式，现在我们来看下`onlyOne = true`的传播延迟中断模式。

在`onlyOne = true`的传播中断模式下，`interruptIdleWorkers()`会中断工作线程集合中的任意一个空闲的工作线程以后直接返回，而不是对所有空闲的工作线程都触发中断请求。而那个被中断的工作线程会按照我们在快速中断模式中分析的行为，在退出时调用`processWorkerExit()`逻辑，而在`processWorkerExit()`逻辑内部又会触发`tryTerminate()`逻辑，在`tryTerminate()`的逻辑中，正如我们上面分析的那样，继续找一个还在工作线程集合中的线程，对它发起中断，不断重复这个过程，保证了中断命令在工作线程集合中得到传播。这种工作机制，可以保证即使当前工作线程集合中存在非空闲的工作线程，在未来某个时间点当它变成空闲线程的时候，中断命令还是会传递到这个工作线程中，最终工作线程集合中的所有worker都被中断并退出。

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

在`processWorkerExit()`中处理工作线程退出逻辑的时候先将工作线程从`workers`集合中删除，然后再执行`tryTerminate()`逻辑，所以中断命令不会重复发到同一个正在执行退出逻辑的工作线程上，保证了传播中的中断命令不会丢失。

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

在这段终止逻辑中，线程池的状态会先变成 **TIDYING**，然后执行终止钩子（hook）方法`terminated()`，这里用了CAS操作来更新 **TIDYING** 状态是为了防止出现竞态。当`terminated()`方法以后线程池的状态就进入终态 **TERMINATED**，在进入终态以后会调用`termination.signalAll()`通知所有阻塞在`awaitTermination()`方法上的应用代码。

回到`shutdown()`的代码，在执行完`interruptIdleWorkers`以后，调用`onShutdown()`钩子（hook）方法执行回调用户自定义的逻辑，最后执行`tryTerminate()`尝试将线程池推向终态。以上就是`shutdown()`关闭线程池的流程，下面我们来看下`shutdownNow()`的逻辑。

### shutdownNow()
通过`shutdownNow()`关闭线程池和`shutdown()`类似，区别在于`shutdownNow()`在关闭线程池的时候会中断所有正在执行的任务，并且情况还在队列中等待执行的任务。

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

对于`setRejectedExecutionHandler()`和`setThreadFactory()`线程池的实现比较简单，由于线程池在实现的时候对`handler`和`threadFactory`加了`volatile`修饰符保证了内存的可见性，所以直接修改对应的配置项的值就可以。对于调整线程池的大小和超时配置的时候，由于需要触发线程池内部进行调整，所以先对麻烦点。

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

在动态调整核心线程池数量`corePoolSize`的时候，如果当前线程池工作线程数量大于新设置的值，则通过`interruptIdleWorkers()`将空闲的工作线程回收。如果设置的新的核心工作线程数量大于原先的核心线程数，则基于当前任务队列中任务的数量和新旧核心工作线程数量之间的差额来进行调整`Math.min(delta, workQueue.size())`，通过`while`信息逐步新增工作线程，如果在新增工作线程的过程中任务队列为空，则停止新增。

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

`allowCoreThreadTimeOut()`方法的逻辑也比较简单，如果新的设置值和原先的`allowCoreThreadTimeOut`值不一样，则修改完以后调用`interruptIdleWorkers()`来触发线程池内部的调整，利用的就是`interruptIdleWorkers()`内部的扩散机制，使得线程池内部达到平衡。`setKeepAliveTime()`和`setMaximumPoolSize()`的实现机制也类似，也是依托于`interruptIdleWorkers()`来实现内部调整，读者可以去看源码分析。下面，我们来分析下线程池是如何管理任务队列中的任务的。

## 任务管理
线程池`ThreadPoolExecutor`内部是通过`BlockingQueue`来存储排队的任务的，所以线程池提供了几个API供开发者管理在任务队列`workQueue`中的任务。

{% highlight java %}
public BlockingQueue<Runnable> getQueue();
public boolean remove(Runnable task);
public void purge();
{% endhighlight %}

方法`purge()`比较特殊，它只支持`Future`类型的任务，所以`purge()`操作需要`Future`特性的支持。`Future`是对一个异步计算的抽象，通过`Future`对象可以对计算任务进行控制，比如获取计算结果，取消计算任务等等。而`purge()`作用是将任务队列中所有已经取消的任务移除。

## 总结
本文分析了Java并发包中线程池的实现，分析了线程池的实现实现原理。介绍了线程池是如何扩容和缩容、线程池如何执行任务以及线程池关闭的过程和细节。
