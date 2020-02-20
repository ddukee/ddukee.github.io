---
layout: post
title: ThreadLocal实现原理
date: "2019-12-09 19:50:00 +0800"
categories: multithread
tags: java multithread concurrency
published: true
---

## 前言
ThreadLocal是Java提供的一种线程私有变量存储机制。通过ThreadLocal每个线程都可以有自己的私有变量，私有变量变量可以防止被线程共享导致线程安全性问题。

我们知道方法内部的局部变量是线程安全的，但是局部变量不能被多个方法栈共享。而ThreadLocal就比较特殊，它是线程安全的并且可以在同一个线程内部共享，即使线程内部调用了多个方法，ThreadLocal变量也可以跨方法栈访问。

本文假定读者已经有了ThreadLocal的使用经历，了解ThreadLocal的基本用法。下面，笔者就带着大家一起分析下Java的ThreadLocal是如何实现的，里面有一些值得我们学习的技巧。

## 存储结构
ThreadLocal内部通过一个哈希表来存储线程私有变量。在ThreadLocal内部，哈希表使用`ThreadLocalMap`来存储。`ThreadLocalMap`内部其实是一个`Entry`类型的数组`Entry[]`。

ThreadLocal在使用这个`Entry`数组的时候，将它构造成了一个环形数组。所以ThreadLocal内部存储线程私有变量的是一个由环形数组组成的哈希表。

![环形数组](/assets/images/thread_local_01.png){:width="65%" hight="65%"}

{% highlight java %}
static class Entry extends WeakReference<ThreadLocal<?>> {
    /** The value associated with this ThreadLocal. */
    Object value;

    Entry(ThreadLocal<?> k, Object v) {
        super(k);
        value = v;
    }
}
{% endhighlight %}

环形数组中存的是`Entry`类型的元素，`Entry`类型继承了`WeakReference`类型。`WeakReference`是Java的一种引用类型。Java中有多种引用类型，我们常见的是强引用。比如：`Integer a = new Integer(1)`创建了一个`Integer`类型的强引用。不同于强引用，`WeakReference`被称为弱引用。它的特点是：如果一个对象只有`WeakReference`类型的引用，那么在GC的时候这个对象会被垃圾回收器回收掉。关于`WeakReference`的内容这里不展开介绍，只要知道如果一个对象只有弱引用，该对象在GC的时候会被垃圾回收器回收。

> Java支持4中类型的引用，分别是强引用、弱引用（WeakReference）、软引用（SoftReference）、虚引用（PhantomReference）。其中，我们接触到最多的是强引用，在java中new一个对象然后赋值给一个变量，那么这个变量持有的就是对这个对象的强引用。至于其他三个引用类型，有不同的引用强弱，主要是配合垃圾回收器进行GC。

`Entry`是一个K-V键值对，其中key是`ThreadLocal<?>`类型的值，它会被`WeakReference`引用，也就是说一旦key值没有强引用，这个key就会在下次GC的时候被回收掉。`Entry`的value值是线程私有变量的值。数组`Entry[]`中的元素是`WeakReference`类型是为了保证当这些entry的key值没有强引用的时候可以被GC，防止因`Entry`数组中引用了这些变量而导致内存泄露。

{% highlight java %}
static class ThreadLocalMap {
  /**
  * The initial capacity -- MUST be a power of two.
  */
  private static final int INITIAL_CAPACITY = 16;

  /**
  * The table, resized as necessary.
  * table.length MUST always be a power of two.
  */
  private Entry[] table;
}
{% endhighlight %}

哈希表`ThreadLocalMap`内部的entry数组`table`的长度值`INITIAL_CAPACITY`必须是2的倍数，默认值是`16`。`INITIAL_CAPACITY`的值必须是2的倍数是因为在哈希表中取模操作是通过按位与（`&`）而不是取模运算符（`%`）来处理的。这么做的好处是效率高，但是使用按位与（`&`）的前提条件是长度必须是2的倍数。

ThreadLocal通过`hashCode & (len - 1)`就对hash值进行取模运算，得到对应的哈希表的bucket下标位置。`hashCode & (len - 1)`等价于`hashCode % len`，前者由于是位运算效率更高。

## 线程内共享

上面介绍完了线程私有变量存储的格式，下面来看下线程私有变量是如何在同一个线程内部共享的。

为了让线程的本地变量可以在同一个线程内共享，ThreadLocal的实现者通过在`Thread`对象上添加了一个`threadLocals`成员变量来表示这个线程自己的本地变量表。

{% highlight java %}
public
class Thread implements Runnable {
  ...
  /* ThreadLocal values pertaining to this thread. This map is maintained
   * by the ThreadLocal class. */
  ThreadLocal.ThreadLocalMap threadLocals = null;
  ...
}
{% endhighlight %}

通过`threadLocals`成员变量，将表示线程的对象和ThreadLocal联系起来，达到线程本地变量在线程内部共享、线程间隔离的目的。

![threadLocals](/assets/images/thread_local_02.png){:width="45%" hight="45%"}

{% highlight java %}
void createMap(Thread t, T firstValue) {
    t.threadLocals = new ThreadLocalMap(this, firstValue);
}
{% endhighlight %}

Thread的`threadLocals`成员变量是在ThreadLocal中设置的，在ThreadLocal中的`createMap`方法中将存储线程私有变量的哈希表赋值给了Thread的`threadLocals`变量。

接下来我们来分析下线程私有变量是如何设置和使用的。

## 获取私有变量
ThreadLocal通过`get()`方法获取线程私有变量。下面是ThreadLocal的`get`方法的代码：

{% highlight java %}
public T get() {
    Thread t = Thread.currentThread();
    ThreadLocalMap map = getMap(t);
    if (map != null) {
        ThreadLocalMap.Entry e = map.getEntry(this);
        if (e != null) {
            @SuppressWarnings("unchecked")
            T result = (T)e.value;
            return result;
        }
    }
    return setInitialValue();
}
{% endhighlight %}

在ThreadLocal的`get()`方法中首先通过`Thread.currentThread()`获取到执行`get()`方法的线程对象`t`，然后通过调用`getMap()`方法获取存储线程私有变量的哈希表。`getMap`的逻辑很简单，就是从线程对象上拿到`threadLocals`变量保存的存储私有变量的哈希表，这块在上一节已经提到过了。

{% highlight java %}
ThreadLocalMap getMap(Thread t) {
    return t.threadLocals;
}
{% endhighlight %}

拿到存储线程私有变量的哈希表`map`以后，首先判断哈希表对象`map`是否为null，如果`map != null`则通过`map`的`getEntry()`方法获取哈希表中的项。前面在介绍哈希表的结构的时候，我们提到了哈希表的key值是ThreadLocal对象本身，所以这里把`this`对象作为参数传入`getEntry()`方法中。下面我们来重点看下`getEntry()`的逻辑：

{% highlight java %}
private Entry getEntry(ThreadLocal<?> key) {
    int i = key.threadLocalHashCode & (table.length - 1);
    Entry e = table[i];
    if (e != null && e.get() == key)
        return e;
    else
        return getEntryAfterMiss(key, i, e);
}
{% endhighlight %}

在`getEntry()`方法中，通过`key.threadLocalHashCode & (table.length - 1)`计算得到key对应的哈希表的位置。前面提到过ThreadLocal的哈希表是使用位运算来执行取模运算的，这里不再熬述。这里讲下ThreadLocal对象的`threadLocalHashCode`值是怎么来的。

{% highlight java %}
public class ThreadLocal<T> {
  private final int threadLocalHashCode = nextHashCode();
  private static AtomicInteger nextHashCode = new AtomicInteger();
  private static final int HASH_INCREMENT = 0x61c88647;
  private static int nextHashCode() {
    return nextHashCode.getAndAdd(HASH_INCREMENT);
  }
  ...
}
{% endhighlight %}

可以看到，在创建ThreadLocal对象的时候会初始化`threadLocalHashCode`成员变量。`threadLocalHashCode`变量的值是通过`nextHashCode()`方法生成的，在`nextHashCode()`方法中可以看到：通过对`nextHashCode`值每次新增`HASH_INCREMENT`得到新的hash值。`HASH_INCREMENT`是一个值为十六进制魔法数字`0x61c88647`的常量。所以ThreadLocal的哈希值`threadLocalHashCode`就是从0开始递增的，每新增一个ThreadLocal变量，下一个ThreadLocal变量的哈希值`threadLocalHashCode`就递增`HASH_INCREMENT`。这里`nextHashCode`是一个`AtomicInteger`类型，保证原子性生成哈希值。

> ThreadLocal的实现者选择 `0x61c88647`作为`HASH_INCREMENT`的值是有原因的，实际上这是一个 **Fibbonachi hashing**[^2] 。将十六进制值`0x61c88647`转换成十进制得到`1640531527`，这个值其实是通过下面的公式计算得到，其中$\phi$的值是黄金分割比率。
>
>$$
> hash\_increment = 2^{32} \times \left(1 - \frac{1}{\phi}\right) \\
> \phi = \frac{1 + \sqrt{5}}{2}
>$$
>
>ThreadLocal引入`0x61c88647`这个值的目的是为了让每次生成的哈希值尽可能的离散。

介绍完`threadLocalHashCode`，回到`getEntry()`。当通过取模运算获得Entry在哈希表的位置以后，通过数组的下标取值操作拿到对应的Entry对象`e`。然后判断`e`的值是否为`null`，如果`e != null`并且`e`的key值和传进来的key值相等，则表示找到了这个key对应的项，直接返回`e`，这里使用`==`等值判断两个对象是否是同一个对象。

如果`e`为空或者`e`中包含的key值不是参数中传入的那个key，也就是定位到的哈希表中的项的key值不是当前我们要查的本地变量的ThreadLocal对象，则执行`getEntryAfterMiss()`进行缺失情况的查找。

这里读者可能会有点疑惑。为什么明明是通过计算哈希值从哈希表中定位到的项，却不是想要的那个key对应的项呢？这是因为在实现ThreadLocalMap哈希表的时候为了解决哈希冲突问题，实现者采用了 **开放地址法（Open addressing）**[^1]来解决冲突。

![Open_addressing](/assets/images/thread_local_03.png){:width="50%" hight="50%"}

简单说就是：拿着计算得到的哈希值去哈希表查，如果发现这个位置被别的具有相同哈希值的key占用了，那么就从这个位置开始往后逐个检查，直到找到一个空的位置把这个key存下来。这个逻辑贯穿了ThreadLocalMap的整个增删改实现，希望读者心里先有个数，下面会遇到。下面我们继续看`getEntryAfterMiss()`的逻辑：

{% highlight java %}
private Entry getEntryAfterMiss(ThreadLocal<?> key, int i, Entry e) {
    Entry[] tab = table;
    int len = tab.length;

    while (e != null) {
        ThreadLocal<?> k = e.get();
        if (k == key)
            return e;
        if (k == null)
            expungeStaleEntry(i);
        else
            i = nextIndex(i, len);
        e = tab[i];
    }
    return null;
}
{% endhighlight %}

`getEntryAfterMiss`的三个入参分别是哈希表的Key————私有变量ThreadLocal对象、首次定位的哈希表的位置i以及对应的Entry对象。在`getEntryAfterMiss`中，注意下`Entry[] tab = table`和`int len = tab.length`这两个逻辑，这两步的作用是将哈希表和长度复制到局部变量中，这么做是考虑到哈希表可能会被其他线程扩容，所以为了保证线程安全这一步是必要的。然后就是一个`while`循环，这里判断`e`是否为空，如果为空则表示哈希表中确实没有这个key对应的`Entry`。

在循环中，首先检查`e`的key是否是当前正在查找的key，如果是则表示从哈希表中找到了对应的entry，直接返回。如果找到的entry中key是`null`，则表示这个线程私有变量被GC了，当前槽位中的entry是废弃的，需要进行清理工作。清理逻辑在`expungeStaleEntry`中；如果当前找到的entry不是当前key对应的entry，也就是说之前有冲突发生，那么通过`nextIndex()`往后找下一个entry。

{% highlight java %}
private static int nextIndex(int i, int len) {
    return ((i + 1 < len) ? i + 1 : 0);
}
{% endhighlight %}

在`nextIndex()`的实现中，可以看出ThreadLocalMap的实现是一个环形哈希表，这我们在最开始的时候已经提到了。下面，我们来看下刚才提到的清理过期entry的逻辑`expungeStaleEntry()`：

{% highlight java %}
private int expungeStaleEntry(int staleSlot) {
    Entry[] tab = table;
    int len = tab.length;

    // expunge entry at staleSlot
    tab[staleSlot].value = null;
    tab[staleSlot] = null;
    size--;

    // Rehash until we encounter null
    Entry e;
    int i;
    for (i = nextIndex(staleSlot, len);
         (e = tab[i]) != null;
         i = nextIndex(i, len)) {
        ThreadLocal<?> k = e.get();
        if (k == null) {
            e.value = null;
            tab[i] = null;
            size--;
        } else {
            int h = k.threadLocalHashCode & (len - 1);
            if (h != i) {
                tab[i] = null;

                // Unlike Knuth 6.4 Algorithm R, we must scan until
                // null because multiple entries could have been stale.
                while (tab[h] != null)
                    h = nextIndex(h, len);
                tab[h] = e;
            }
        }
    }
    return i;
}
{% endhighlight %}

`expungeStaleEntry()`方法的入参是在哈希表中需要被清理的槽位的下标`staleSlot`。和前面`getEntryAfterMiss`中一样，这里先复制了哈希表和哈希表长度的索引，然后将哈希表中`staleSlot`对应的位置设置为空，清理掉废弃的entry的同时减少哈希表中项的数量值`size`。由于哈希表是通过开放地址法处理碰撞的，所以`expungeStaleEntry()`在清理了`staleSlot`位置的废弃entry以后还需要对在`staleSlot`后面的entry进行重新哈希。这么做为了减少entry间的空隙，降低entry的离散程度，修复因为冲突解决算法导致的定位key效率降低的问题。

![expunge_stale_entry](/assets/images/thread_local_04.png){:width="85%" hight="85%"}

ThreadLocalMap的哈希表是一个环形数组，上图中为了方便展示将环形数组平铺开展示。从图中可以看到，在重新哈希的过程中，如果碰到废弃的entry会顺便把这些entry回收掉，把对应的槽位设置为`null`。如果遇到了正常的entry，则重新进行哈希并且在发生冲突的时候按照开放地址算法解决冲突。最终返回的是本次检查中没有被检查到的第一个空槽位的下标。

现在我们回到`get()`方法的逻辑，`getEntry()`方法从哈希表中返回包含当前ThreadLocal对象的entry值`e`，判断`e`是否为空。如果`e`不为空则直接返回`e`中的`value`————也就是这个本地变量的值；如果`e`为空或者哈希表不存在，则执行`setInitialValue()`方法初始化初始值并返回设置的初始值。

{% highlight java %}
private T setInitialValue() {
    T value = initialValue();
    Thread t = Thread.currentThread();
    ThreadLocalMap map = getMap(t);
    if (map != null)
        map.set(this, value);
    else
        createMap(t, value);
    return value;
}
{% endhighlight %}

在`setInitialValue()`中调用`initialValue()`获取初始值。`initialValue()`方法是我们在创建线程私有变量的时候实现的方法。ThreadLocal的`get()`方法的分析就到这里了，下面我们开始分析ThreadLocal的`set()`方法。

## 设置私有变量
{% highlight java %}
public void set(T value) {
    Thread t = Thread.currentThread();
    ThreadLocalMap map = getMap(t);
    if (map != null)
        map.set(this, value);
    else
        createMap(t, value);
}
{% endhighlight %}

`set()`方法获取线程私有变量哈希表的逻辑和`get()`方法类似，这里不再熬述。我们来重点看下哈希表ThreadLocalMap的`set()`方法的逻辑。

{% highlight java %}
private void set(ThreadLocal<?> key, Object value) {

    // We don't use a fast path as with get() because it is at
    // least as common to use set() to create new entries as
    // it is to replace existing ones, in which case, a fast
    // path would fail more often than not.

    Entry[] tab = table;
    int len = tab.length;
    int i = key.threadLocalHashCode & (len-1);

    for (Entry e = tab[i];
         e != null;
         e = tab[i = nextIndex(i, len)]) {
        ThreadLocal<?> k = e.get();

        if (k == key) {
            e.value = value;
            return;
        }

        if (k == null) {
            replaceStaleEntry(key, value, i);
            return;
        }
    }

    tab[i] = new Entry(key, value);
    int sz = ++size;
    if (!cleanSomeSlots(i, sz) && sz >= threshold)
        rehash();
}
{% endhighlight %}

在ThreadLocalMap的`set()`方法中，先根据key计算得到的哈希值获取哈希表的位置`i`，然后从位置`i`开始使用开放地址算法往后逐个检查哈希表的槽位。如果槽位中的entry的key中恰好是私有变量的key值，则直接更新这个entry的`value`字段；如果发现entry已经废弃，则通过`replaceStaleEntry()`将对应槽位的entry替换成新的值；如果遍历完哈希表中所有的entry也没有找到当前key对应的entry，则在最靠近的空槽位上创建一个新的entry，将线程私有变量设置到这个槽位中并将`size`的值递增。

![set](/assets/images/thread_local_05.png){:width="85%" hight="85%"}

最后，通过`cleanSomeSlots()`对哈希表做一次清理并检查清理后的哈希表中现有entry的数量是否超过阈值`threshold`，如果超过阈值则调用`rehash()`进行扩容和重新哈希。

我们先来分析下`replaceStaleEntry()`替换废弃entry的逻辑。代码如下：

{% highlight java %}
private void replaceStaleEntry(ThreadLocal<?> key, Object value,
                                int staleSlot) {
     Entry[] tab = table;
     int len = tab.length;
     Entry e;

     // Back up to check for prior stale entry in current run.
     // We clean out whole runs at a time to avoid continual
     // incremental rehashing due to garbage collector freeing
     // up refs in bunches (i.e., whenever the collector runs).
     int slotToExpunge = staleSlot;
     for (int i = prevIndex(staleSlot, len);
          (e = tab[i]) != null;
          i = prevIndex(i, len))
         if (e.get() == null)
             slotToExpunge = i;

     // Find either the key or trailing null slot of run, whichever
     // occurs first
     for (int i = nextIndex(staleSlot, len);
          (e = tab[i]) != null;
          i = nextIndex(i, len)) {
         ThreadLocal<?> k = e.get();

         // If we find key, then we need to swap it
         // with the stale entry to maintain hash table order.
         // The newly stale slot, or any other stale slot
         // encountered above it, can then be sent to expungeStaleEntry
         // to remove or rehash all of the other entries in run.
         if (k == key) {
             e.value = value;

             tab[i] = tab[staleSlot];
             tab[staleSlot] = e;

             // Start expunge at preceding stale entry if it exists
             if (slotToExpunge == staleSlot)
                 slotToExpunge = i;
             cleanSomeSlots(expungeStaleEntry(slotToExpunge), len);
             return;
         }

         // If we didn't find stale entry on backward scan, the
         // first stale entry seen while scanning for key is the
         // first still present in the run.
         if (k == null && slotToExpunge == staleSlot)
             slotToExpunge = i;
     }

     // If key not found, put new entry in stale slot
     tab[staleSlot].value = null;
     tab[staleSlot] = new Entry(key, value);

     // If there are any other stale entries in run, expunge them
     if (slotToExpunge != staleSlot)
         cleanSomeSlots(expungeStaleEntry(slotToExpunge), len);
}
{% endhighlight %}

`replaceStaleEntry()`的逻辑相对前面会复杂一点，我们来逐步分析。在`replaceStaleEntry()`中，ThreadLocalMap的实现者将一段连续有key存在的区域称为一个 **系列（run）**。

![run](/assets/images/thread_local_06.png){:width="80%" hight="80%"}

在`replaceStaleEntry()`方法中，先找到哈希表中当前需要被替换的槽位所属的系列中，最靠前的需要弃用的槽位的下标`slotToExpunge`，直到到达一个 **系列（run）** 的边界，也就是到达空的槽位为止。

{% highlight java %}
int slotToExpunge = staleSlot;
for (int i = prevIndex(staleSlot, len);
    (e = tab[i]) != null;
    i = prevIndex(i, len))
    if (e.get() == null)
        slotToExpunge = i;
{% endhighlight %}

![slotToExpunge](/assets/images/thread_local_07.png){:width="80%" hight="80%"}

找到一个 **系列（run）** 中最靠前的废弃的槽位`slotToExpunge`（如果能找到的话，如果找不到则表示在`staleSlot`前面没有废弃的槽位，那`staleSlot`就是该run中最靠前的废弃槽位）以后，开始从`staleSlot`的下一个位置开始，在所在的run中找是否有因为key的哈希值冲突而导致放在别的槽位中的key（这里只在当前run中找是因为基于开放地址算法的原理，如果一个key发生冲突，这个key肯定和被碰撞的那个key在一个run中，这也是实现者这么定义run的原因）。

{% highlight java %}
for (int i = nextIndex(staleSlot, len);
     (e = tab[i]) != null;
     i = nextIndex(i, len)) {
    ThreadLocal<?> k = e.get();

    // If we find key, then we need to swap it
    // with the stale entry to maintain hash table order.
    // The newly stale slot, or any other stale slot
    // encountered above it, can then be sent to expungeStaleEntry
    // to remove or rehash all of the other entries in run.
    if (k == key) {
        e.value = value;

        tab[i] = tab[staleSlot];
        tab[staleSlot] = e;

        // Start expunge at preceding stale entry if it exists
        if (slotToExpunge == staleSlot)
            slotToExpunge = i;
        cleanSomeSlots(expungeStaleEntry(slotToExpunge), len);
        return;
    }

    // If we didn't find stale entry on backward scan, the
    // first stale entry seen while scanning for key is the
    // first still present in the run.
    if (k == null && slotToExpunge == staleSlot)
        slotToExpunge = i;
}
{% endhighlight %}

如果在run中找到了对应的key，则将找到的key的槽位中的entry和废弃的槽位`staleSlot`的entry互换位置，同时检查`slotToExpunge`的值是否和`staleSlot`相同，如果相同则表示当前run中最靠前的废弃槽位就是`staleSlot`对应的位置，需要将`slotToExpunge`的值赋值为`i`，因为现在原先`staleSlot`的位置已经不是原先废弃槽位了，交换位置以后新的废弃槽位变成了`i`所在的位置。

![exchange](/assets/images/thread_local_08.png){:width="85%" hight="85%"}

替换位置操作完成以后，调用`expungeStaleEntry()`方法将最靠前的废弃槽位`slotToExpunge`中的entry删除。`expungeStaleEntry()`的逻辑前面已经分析过了，这里不再展开。`expungeStaleEntry()`返回的是被清理的废弃槽位所在的run后面第一个空槽位的下标，将这个下标作为参数调用`cleanSomeSlots()`方法去清理废弃的槽位。下面看下`cleanSomeSlots()`做了什么操作：

{% highlight java %}
private boolean cleanSomeSlots(int i, int n) {
    boolean removed = false;
    Entry[] tab = table;
    int len = tab.length;
    do {
        i = nextIndex(i, len);
        Entry e = tab[i];
        if (e != null && e.get() == null) {
            n = len;
            removed = true;
            i = expungeStaleEntry(i);
        }
    } while ( (n >>>= 1) != 0);
    return removed;
}
{% endhighlight %}

在`cleanSomeSlots()`方法中，第一个参数`i`表示开始扫描的起始位置，起始位置所在的槽位不能是废弃的槽位。第二个参数`n`控制扫描的方式：如果扫描过程中没有发现废弃的槽位，则只扫描$log_2(n)$个槽位；如果发现了一个废弃的槽位则变成扫描$log_2(len)$个槽位。每次扫描$log_2(n)$而不是$n$个槽位是为了兼顾GC和性能的考虑。

如果在当前run中没有找到key则表示没有冲突发生，直接创建新的entry并将这个entry放在原先废弃的槽位中，然后检查`slotToExpunge`的值是否和`staleSlot`一样，如果不一样则表示在当前run中有废弃的槽位，对`slotToExpunge`位置的槽位执行`expungeStaleEntry()`将废弃的槽位清除，并通过`cleanSomeSlots()`检查当前run之外是否有废弃的槽位需要被清理。

![clean](/assets/images/thread_local_09.png){:width="90%" hight="90%"}

分析完`replaceStaleEntry()`逻辑，下面我们来看下`set()`方法中的`rehash()`是怎么对哈希表的entry进行重新哈希的。

{% highlight java %}
private void rehash() {
    expungeStaleEntries();

    // Use lower threshold for doubling to avoid hysteresis
    if (size >= threshold - threshold / 4)
        resize();
}

private void expungeStaleEntries() {
    Entry[] tab = table;
    int len = tab.length;
    for (int j = 0; j < len; j++) {
        Entry e = tab[j];
        if (e != null && e.get() == null)
            expungeStaleEntry(j);
    }
}
{% endhighlight %}

`rehash()`的逻辑分为两块，先是通过`expungeStaleEntries()`将哈希表中所有废弃的entry都清理掉。在`expungeStaleEntries()`内部是通过遍历哈希表，对所有废弃的槽位调用`expungeStaleEntry()`来进行回收的。将哈希表的废弃槽位清理以后，检查当前哈希表的大小`size`是否超过阈值`threshold - threshold / 4`，如果超过则进行`resize()`操作。`threshold`的默认值是哈希表长度的`2/3`，所以当哈希表中的数量超过了当前哈希表长度的`5/6`的时候就会触发扩容。

{% highlight java %}
private void resize() {
    Entry[] oldTab = table;
    int oldLen = oldTab.length;
    int newLen = oldLen * 2;
    Entry[] newTab = new Entry[newLen];
    int count = 0;

    for (int j = 0; j < oldLen; ++j) {
        Entry e = oldTab[j];
        if (e != null) {
            ThreadLocal<?> k = e.get();
            if (k == null) {
                e.value = null; // Help the GC
            } else {
                int h = k.threadLocalHashCode & (newLen - 1);
                while (newTab[h] != null)
                    h = nextIndex(h, newLen);
                newTab[h] = e;
                count++;
            }
        }
    }

    setThreshold(newLen);
    size = count;
    table = newTab;
}
{% endhighlight %}

在`resize()`中扩容机制是按照原先长度的2倍扩容（前面提到过ThreadLocalMap的实现是采用位运算来进行取模的，所以哈希表的长度必须是2的倍数）。在扩容拷贝的过程中，对废弃的entry直接丢失，对于没有废弃的槽位，按照新的长度进行哈希以后放到新的哈希表中，如果出现冲突则还是采用开放地址法进行冲突解决。

到这里ThreadLocal设置私有变量的逻辑已经讲完了，实现者在设置私有变量的过程中做了很多巧妙的设计，下面来看下删除私有变量的代码。

## 删除私有变量

{% highlight java %}
public void remove() {
    ThreadLocalMap m = getMap(Thread.currentThread());
    if (m != null)
        m.remove(this);
}
{% endhighlight %}

ThreadLocal删除私有变量的逻辑相对比较简单。首先和前面增删逻辑一样，也是通过线程对象拿到线程对应的ThreadLocalMap哈希表。然后调用`map.remove(this)`删除对应key的私有变量。

{% highlight java %}
private void remove(ThreadLocal<?> key) {
    Entry[] tab = table;
    int len = tab.length;
    int i = key.threadLocalHashCode & (len-1);
    for (Entry e = tab[i];
         e != null;
         e = tab[i = nextIndex(i, len)]) {
        if (e.get() == key) {
            e.clear();
            expungeStaleEntry(i);
            return;
        }
    }
}
{% endhighlight %}

哈希表ThreadLocalMap的`remove()`方法逻辑比较直观：先计算key的哈希值，然后在哈希表中查找这个key，如果找到了这个key就调用Entry的`clear()`方法清理引用然后再调用`expungeStaleEntry()`方法将该槽位清理掉后返回；如果没有找到则继续往后找，直到遇到空槽位为止。

## 总结
到这里，差不多已经把ThreadLocal中关于线程私有变量的增删改逻辑分析完了。相信读者看完也已经大致了解了ThreadLocal的实现原理。在本文中提到了Java中强、弱、虚引用的概念，有机会再写篇文章讲讲Java中关于这几种引用的概念。

[^1]: 开放地址法 [https://en.wikipedia.org/wiki/Open_addressing](https://en.wikipedia.org/wiki/Open_addressing){:target="\_blank"}
[^2]: FibbonachiHashing [https://web.archive.org/web/20161121124236/http://brpreiss.com/books/opus4/html/page214.html](https://web.archive.org/web/20161121124236/http://brpreiss.com/books/opus4/html/page214.html){:target="\_blank"}